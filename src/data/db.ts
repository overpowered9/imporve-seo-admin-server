import postgres from 'postgres'
import { configDotenv } from 'dotenv'
configDotenv();
const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is not set')
}

const supabase_sql = postgres(connectionString, {
  // Pool sizing — keep modest so we don't exhaust the Postgres/pooler connection
  // budget on a small instance.
  max: 10,
  // Fail fast if the database/pooler is unreachable. Without this the default is
  // 30s, so a brief network blip makes every auth request hang for half a minute
  // (and the client times out) instead of erroring quickly and letting it retry.
  connect_timeout: 10,
  // Recycle idle and long-lived connections so dead sockets behind a pooler/NAT
  // are not handed to a query (a common cause of "Connection terminated" errors).
  idle_timeout: 30,
  max_lifetime: 60 * 30,
  // NOTE: if DATABASE_URL ever points at Supabase's TRANSACTION-mode pooler
  // (port 6543), add `prepare: false` here — prepared statements are not
  // supported in that mode and cause random "prepared statement already exists"
  // errors. Session-mode pooler (5432) and direct connections are fine as-is.
})
export const testConnection = async () =>  {
  try {
    // Test raw Postgres connection
    const result = await supabase_sql`SELECT NOW()`
    console.log('✅ PostgreSQL connected:', result[0].now)

   

    console.log('✅ Supabase API connected')
    return { status: 'ok' }
  } catch (err) {
    console.error('❌ Connection failed:', err)
    return { status: 'error', error: err }
  }
}
export default supabase_sql