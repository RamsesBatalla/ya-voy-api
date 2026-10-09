import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL no definida');

export const sql = postgres(process.env.DATABASE_URL, {
  ssl: 'require',
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

const supabaseUrl = process.env.SUPABASE_URL || 'https://qqwpfypjwdetljyzkogo.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseKey);
