import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Thesis API is running' });
});

app.post('/api/auth/login', (req, res) => {
  res.json({ message: 'Login endpoint' });
});

app.post('/api/auth/register', (req, res) => {
  res.json({ message: 'Register endpoint' });
});

app.listen(PORT, () => {
  console.log(`Thesis API running on port ${PORT}`);
});
