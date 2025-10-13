#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const BACKUP_DIR = path.join(__dirname, 'backups');

// Check if backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
  console.error('❌ No backups directory found. Run a backup first!');
  process.exit(1);
}

// Get all backup folders
const backups = fs.readdirSync(BACKUP_DIR)
  .filter(name => name.startsWith('backup_'))
  .map(name => {
    const backupPath = path.join(BACKUP_DIR, name);
    const infoPath = path.join(backupPath, 'backup_info.json');
    
    let info = null;
    if (fs.existsSync(infoPath)) {
      info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    }
    
    return {
      name,
      path: backupPath,
      time: fs.statSync(backupPath).mtime,
      info
    };
  })
  .sort((a, b) => b.time - a.time); // Sort by newest first

if (backups.length === 0) {
  console.error('❌ No backups found!');
  process.exit(1);
}

// Display available backups
console.log('\n📦 Available Backups:\n');
backups.forEach((backup, index) => {
  const date = backup.time.toLocaleString();
  const filesCount = backup.info ? backup.info.backedUpCount : 'unknown';
  const version = backup.info ? backup.info.version : 'unknown';
  console.log(`${index + 1}. ${date} (v${version}) - ${filesCount} files`);
});

// Get backup selection from command line or interactive
const selectedIndex = process.argv[2] ? parseInt(process.argv[2]) - 1 : null;

if (selectedIndex !== null && selectedIndex >= 0 && selectedIndex < backups.length) {
  performRestore(backups[selectedIndex]);
} else if (selectedIndex !== null) {
  console.error('❌ Invalid backup number!');
  process.exit(1);
} else {
  // Interactive mode
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  rl.question('\nEnter backup number to restore (or "q" to quit): ', (answer) => {
    rl.close();
    
    if (answer.toLowerCase() === 'q') {
      console.log('👋 Restore cancelled');
      process.exit(0);
    }
    
    const index = parseInt(answer) - 1;
    if (index >= 0 && index < backups.length) {
      performRestore(backups[index]);
    } else {
      console.error('❌ Invalid backup number!');
      process.exit(1);
    }
  });
}

function performRestore(backup) {
  console.log(`\n🔄 Restoring backup from ${backup.time.toLocaleString()}...`);
  
  try {
    // Create backup of current files before restoring
    const beforeRestoreDir = path.join(BACKUP_DIR, `before_restore_${Date.now()}`);
    fs.mkdirSync(beforeRestoreDir, { recursive: true });
    
    const DATA_FILES = ['alert_settings.json', 'daily_stats.json', 'data_history.json', 'package.json'];
    const SENSITIVE_FILES = ['.env'];
    const SSL_FILES = ['ssl/server.crt', 'ssl/server.conf'];
    let restoredCount = 0;
    let skippedCount = 0;
    let sensitiveCount = 0;
    let sslCount = 0;
    
    // Backup current files first
    console.log('\n💾 Creating safety backup of current files...');
    DATA_FILES.forEach(file => {
      const currentPath = path.join(__dirname, file);
      if (fs.existsSync(currentPath)) {
        fs.copyFileSync(currentPath, path.join(beforeRestoreDir, file));
        console.log(`  ✓ Saved current ${file}`);
      }
    });
    
    // Backup current sensitive files (if they exist)
    SENSITIVE_FILES.forEach(file => {
      const currentPath = path.join(__dirname, file);
      if (fs.existsSync(currentPath)) {
        fs.copyFileSync(currentPath, path.join(beforeRestoreDir, file));
        console.log(`  ✓ Saved current ${file}`);
      }
    });
    
    // Backup current SSL files (if they exist)
    SSL_FILES.forEach(file => {
      const currentPath = path.join(__dirname, file);
      if (fs.existsSync(currentPath)) {
        const sslDir = path.join(beforeRestoreDir, path.dirname(file));
        if (!fs.existsSync(sslDir)) {
          fs.mkdirSync(sslDir, { recursive: true });
        }
        fs.copyFileSync(currentPath, path.join(beforeRestoreDir, file));
        console.log(`  ✓ Saved current ${file}`);
      }
    });
    
    // Restore files from backup
    console.log('\n📥 Restoring data files...');
    DATA_FILES.forEach(file => {
      const sourcePath = path.join(backup.path, file);
      const destPath = path.join(__dirname, file);
      
      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, destPath);
        const stats = fs.statSync(sourcePath);
        const sizeKB = (stats.size / 1024).toFixed(2);
        console.log(`✅ Restored ${file} (${sizeKB} KB)`);
        restoredCount++;
      } else {
        console.log(`⚠️  Skipped ${file} (not in backup)`);
        skippedCount++;
      }
    });
    
    // Restore sensitive files (API keys, etc.)
    console.log('\n🔐 Restoring sensitive configuration...');
    SENSITIVE_FILES.forEach(file => {
      const sourcePath = path.join(backup.path, file);
      const destPath = path.join(__dirname, file);
      
      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, destPath);
        const stats = fs.statSync(sourcePath);
        const sizeKB = (stats.size / 1024).toFixed(2);
        console.log(`🔑 Restored ${file} (${sizeKB} KB) - Contains API keys!`);
        sensitiveCount++;
      } else {
        console.log(`⚠️  ${file} not found in backup (you may need to configure manually)`);
      }
    });
    
    // Restore SSL certificate files
    console.log('\n🔒 Restoring SSL certificates...');
    SSL_FILES.forEach(file => {
      const sourcePath = path.join(backup.path, file);
      const destPath = path.join(__dirname, file);
      
      if (fs.existsSync(sourcePath)) {
        // Create SSL directory if it doesn't exist
        const sslDir = path.dirname(destPath);
        if (!fs.existsSync(sslDir)) {
          fs.mkdirSync(sslDir, { recursive: true });
        }
        
        fs.copyFileSync(sourcePath, destPath);
        const stats = fs.statSync(sourcePath);
        const sizeKB = (stats.size / 1024).toFixed(2);
        console.log(`🔒 Restored ${file} (${sizeKB} KB) - SSL certificate`);
        sslCount++;
      } else {
        console.log(`⚠️  ${file} not found in backup (HTTPS may not work)`);
      }
    });
    
    console.log(`\n🎉 Restore completed successfully!`);
    console.log(`📊 Data files restored: ${restoredCount}`);
    console.log(`🔐 Sensitive files restored: ${sensitiveCount}`);
    console.log(`🔒 SSL certificates restored: ${sslCount}`);
    if (skippedCount > 0) {
      console.log(`⚠️  Files skipped: ${skippedCount}`);
    }
    console.log(`\n💡 Your previous files are saved at:\n   ${beforeRestoreDir}`);
    
    if (sensitiveCount > 0) {
      console.log(`\n🔑 API keys and sensitive configuration have been restored!`);
    }
    if (sslCount > 0) {
      console.log(`🔒 SSL certificates restored - HTTPS will work after restart!`);
    }
    
    console.log(`\n⚠️  Remember to restart the application: pm2 restart solar-dashboard`);
    
  } catch (error) {
    console.error('❌ Restore failed:', error.message);
    process.exit(1);
  }
}

