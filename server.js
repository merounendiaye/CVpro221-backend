/**
 * CVpro221 — Serveur de paiement (PayDunya)
 * ------------------------------------------
 * Ce serveur fait 3 choses :
 *  1. POST /api/create-payment  -> crée une facture PayDunya et renvoie le lien de paiement
 *  2. POST /api/callback        -> reçoit la confirmation de PayDunya (IPN) et enregistre le paiement
 *  3. GET  /api/verify/:token   -> vérifie si un token a bien été payé (utilisé par la page de retour)
 *
 * IMPORTANT :
 *  - Ne mets JAMAIS tes vraies clés API directement dans ce fichier.
 *    Mets-les dans un fichier ".env" (voir .env.example) qui ne doit jamais être partagé publiquement.
 *  - Ce serveur utilise un simple fichier JSON comme "base de données" (payments.json).
 *    C'est suffisant pour démarrer, mais pour un vrai site avec plusieurs utilisateurs simultanés,
 *    il faudra migrer vers une vraie base de données (PostgreSQL, MongoDB...).
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // PayDunya envoie l'IPN en x-www-form-urlencoded

const PORT = process.env.PORT || 3000;

// Mode "test" ou "live" — commence toujours en "test" tant que tu n'as pas vérifié que tout marche.
const PAYDUNYA_MODE = process.env.PAYDUNYA_MODE || 'test';
const BASE_URL = PAYDUNYA_MODE === 'live'
  ? 'https://app.paydunya.com/api/v1'
  : 'https://app.paydunya.com/sandbox-api/v1';

const PAYDUNYA_HEADERS = {
  'Content-Type': 'application/json',
  'PAYDUNYA-MASTER-KEY': process.env.PAYDUNYA_MASTER_KEY,
  'PAYDUNYA-PRIVATE-KEY': process.env.PAYDUNYA_PRIVATE_KEY,
  'PAYDUNYA-TOKEN': process.env.PAYDUNYA_TOKEN,
};

// URL publique de TON serveur une fois déployé (ex: https://cvpro221-api.onrender.com)
const SERVER_PUBLIC_URL = process.env.SERVER_PUBLIC_URL || `http://localhost:${PORT}`;
// URL où sont hébergées tes pages HTML (Netlify, GitHub Pages...)
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5500';

const DB_PATH = path.join(__dirname, 'payments.json');
function readDB() {
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '{}');
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// 1) Créer une facture PayDunya et obtenir le lien de paiement
// ---------------------------------------------------------------------------
app.post('/api/create-payment', async (req, res) => {
  const { name, email, phone } = req.body;

  if (!name || !email || !phone) {
    return res.status(400).json({ error: 'Nom, email et téléphone sont obligatoires.' });
  }

  try {
    const invoiceData = {
      invoice: {
        total_amount: 500, // montant en FCFA
        description: 'Accès CVpro221 — génération de CV professionnel',
        customer: { name, email, phone },
      },
      store: {
        name: 'CVpro221',
        website_url: FRONTEND_URL,
      },
      actions: {
        cancel_url: `${FRONTEND_URL}/CVpro221_Inscription.html?payment=cancelled`,
        return_url: `${FRONTEND_URL}/Generateur_CV_Prototype.html`, // PayDunya y ajoute ?token=...
        callback_url: `${SERVER_PUBLIC_URL}/api/callback`,
      },
      // Identifiants exacts reconnus par PayDunya pour le Sénégal (le paiement carte
      // se configure séparément dans les paramètres de ton compte PayDunya, pas ici).
      channels: ['orange-money-senegal', 'wave-senegal'],
    };

    const response = await axios.post(
      `${BASE_URL}/checkout-invoice/create`,
      invoiceData,
      { headers: PAYDUNYA_HEADERS }
    );

    if (response.data.response_code === '00') {
      // On enregistre la facture comme "en attente" en base
      const db = readDB();
      db[response.data.token] = {
        status: 'pending',
        name, email, phone,
        created_at: new Date().toISOString(),
      };
      writeDB(db);

      return res.json({
        payment_url: response.data.response_text, // lien vers la page de paiement PayDunya
        token: response.data.token,
      });
    }

    return res.status(400).json({ error: response.data.response_text });
  } catch (err) {
    console.error(err.response?.data || err.message);
    return res.status(500).json({ error: 'Erreur lors de la création du paiement.' });
  }
});

// ---------------------------------------------------------------------------
// 2) Callback IPN — PayDunya nous informe ici qu'un paiement est confirmé
// ---------------------------------------------------------------------------
app.post('/api/callback', (req, res) => {
  try {
    const data = req.body.data ? JSON.parse(req.body.data) : req.body;
    const token = data.invoice?.token;
    const status = data.status; // "completed" | "cancelled" | "failed"

    if (token) {
      const db = readDB();
      if (!db[token]) db[token] = {};
      db[token].status = status;
      db[token].confirmed_at = new Date().toISOString();
      db[token].customer = data.customer;
      writeDB(db);
      console.log(`Paiement ${token} -> statut : ${status}`);
    }

    res.sendStatus(200); // PayDunya attend juste un 200 OK
  } catch (err) {
    console.error('Erreur callback:', err.message);
    res.sendStatus(500);
  }
});

// ---------------------------------------------------------------------------
// 3) Vérifier si un token a été payé (utilisé par le générateur de CV avant de débloquer l'accès)
// ---------------------------------------------------------------------------
app.get('/api/verify/:token', async (req, res) => {
  const { token } = req.params;
  const db = readDB();

  // Si on l'a déjà en base avec un statut connu, on répond directement
  if (db[token] && db[token].status === 'completed') {
    return res.json({ paid: true });
  }

  // Sinon on interroge directement PayDunya pour être sûr (au cas où l'IPN n'est pas encore arrivée)
  try {
    const response = await axios.get(
      `${BASE_URL}/checkout-invoice/confirm/${token}`,
      { headers: PAYDUNYA_HEADERS }
    );
    const paid = response.data.status === 'completed';
    if (paid) {
      db[token] = { ...(db[token] || {}), status: 'completed' };
      writeDB(db);
    }
    return res.json({ paid });
  } catch (err) {
    console.error(err.response?.data || err.message);
    return res.json({ paid: false });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur CVpro221 démarré sur le port ${PORT} (mode PayDunya: ${PAYDUNYA_MODE})`);
});
