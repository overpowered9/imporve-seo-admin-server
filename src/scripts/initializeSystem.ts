import { seedFixedTemplates } from './seedFixedTemplates.js';
import mongoose from 'mongoose';

/**
 * Initialize the system with fixed templates
 * This should be run once during deployment or when setting up a new environment
 */
async function initializeSystem(): Promise<void> {
  console.log('🚀 Initializing ImproveSEO Server System...');
  
  try {
    // Seed fixed templates
    await seedFixedTemplates();
    console.log('✅ System initialization completed successfully');
    
  } catch (error) {
    console.error('💥 System initialization failed:', error);
    throw error;
  } finally {
    // Close mongoose connection
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
  }
}

// Allow direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  initializeSystem()
    .then(() => {
      console.log('🎉 System ready!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 System initialization failed:', error);
      process.exit(1);
    });
}

export { initializeSystem };