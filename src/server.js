require('./db'); // falha cedo se DATABASE_URL não estiver configurada
const app = require('./app');
const config = require('./config');

app.listen(config.port, () => {
  console.log(`foto-facial-match rodando em http://localhost:${config.port} (face provider: ${config.faceProvider})`);
});
