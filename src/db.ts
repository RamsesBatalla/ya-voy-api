import { neon } from '@neondatabase/serverless';
import 'dotenv/config';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL no definida');
export const sql = neon(process.env.DATABASE_URL);
