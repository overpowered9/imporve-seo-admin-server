import postgres from 'postgres'
import { configDotenv } from 'dotenv'
configDotenv();
const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is not set')
}

const supabase_sql = postgres(connectionString)
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