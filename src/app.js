const express = require('express');
const path = require('node:path');
const authRoutes = require('./routes/auth');
const mediaRoutes = require('./routes/media');
const matchRoutes = require('./routes/match');
const orderRoutes = require('./routes/orders');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/match', matchRoutes);
app.use('/api/orders', orderRoutes);

// 404 padrão
app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

// Handler de erro genérico — nunca vaza stack trace pro cliente.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno. Tente novamente mais tarde.' });
});

module.exports = app;
