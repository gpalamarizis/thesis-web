import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Thesis API is running',
    timestamp: new Date().toISOString()
  });
});

// Auth endpoints
app.post('/api/auth/login', (req, res) => {
  res.json({ message: 'Login endpoint' });
});

app.post('/api/auth/register', (req, res) => {
  res.json({ message: 'Register endpoint' });
});

// Cases endpoint
app.get('/api/cases', (req, res) => {
  res.json({ data: [] });
});

app.listen(PORT, () => {
  console.log(`✅ Thesis API running on port ${PORT}`);
});
