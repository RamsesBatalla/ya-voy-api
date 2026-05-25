require("dotenv").config();
const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);
async function run() {
  await sql.query("DELETE FROM pedidos");
  await sql.query("DELETE FROM productos");
  await sql.query("DELETE FROM viveres");
  await sql.query("DELETE FROM solicitudes");
  await sql.query("DELETE FROM usuarios");
  console.log("Todo limpiado");
}
run().catch(e => console.error(e.message));
