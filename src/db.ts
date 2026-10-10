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
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxd3BmeXBqd2RldGxqeXprb2dvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1MjA0NzIsImV4cCI6MjEwNzA5NjQ3Mn0.kPKaCRCLb9ounPF7_lcwJxIjXule7gUocPvprySL3Bs';

export const supabase = createClient(supabaseUrl, supabaseKey);

