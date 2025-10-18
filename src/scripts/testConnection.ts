import mongoose from 'mongoose';

async function testConnection() {
  try {
    console.log('🔌 Testing MongoDB connection...');
    await mongoose.connect('mongodb://localhost:27017/improveseo');
    console.log('✅ MongoDB connected successfully');
    
    if (mongoose.connection.db) {
      const collections = await mongoose.connection.db.listCollections().toArray();
      console.log('📋 Existing collections:', collections.map(c => c.name));
    } else {
      console.log('📋 Database connection not available');
    }
    
    await mongoose.connection.close();
    console.log('🔌 Connection closed');
  } catch (error) {
    console.error('❌ Connection failed:', error);
  }
}

testConnection();