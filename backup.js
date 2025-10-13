#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Files to backup
const DATA_FILES = [
  'alert_settings.json',
  'daily_stats.json',
  'data_history.json',
  'package.json'
];

// Sensitive files to backup (contains API keys and SSL certificates)
const SENSITIVE_FILES = [
  '.env'
];

// SSL certificate files to backup
const SSL_FILES = [
  'ssl/server.crt',
  'ssl/server.conf'
];

// Backup directory
const BACKUP_DIR = path.join(__dirname, 'backups');

// Create backup directory if it doesn't exist
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  console.log('📁 Created backup directory');
}

// Generate timestamp for backup folder
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
const backupFolder = path.join(BACKUP_DIR, `backup_${timestamp}`);

try {
  // Create timestamped backup folder
  fs.mkdirSync(backupFolder, { recursive: true });
  
  let backedUpCount = 0;
  let skippedCount = 0;
  let sensitiveCount = 0;
  
  // Copy each data file to backup folder
  DATA_FILES.forEach(file => {
    const sourcePath = path.join(__dirname, file);
    const destPath = path.join(backupFolder, file);
    
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, destPath);
      const stats = fs.statSync(sourcePath);
      const sizeKB = (stats.size / 1024).toFixed(2);
      console.log(`✅ Backed up ${file} (${sizeKB} KB)`);
      backedUpCount++;
    } else {
      console.log(`⚠️  Skipped ${file} (not found)`);
      skippedCount++;
    }
  });
  
  // Backup sensitive files (API keys, etc.)
  console.log('\n🔐 Backing up sensitive configuration...');
  SENSITIVE_FILES.forEach(file => {
    const sourcePath = path.join(__dirname, file);
    const destPath = path.join(backupFolder, file);
    
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, destPath);
      const stats = fs.statSync(sourcePath);
      const sizeKB = (stats.size / 1024).toFixed(2);
      console.log(`🔑 Backed up ${file} (${sizeKB} KB) - Contains API keys!`);
      sensitiveCount++;
    } else {
      console.log(`⚠️  Skipped ${file} (not found)`);
    }
  });
  
  // Backup SSL certificate files
  console.log('\n🔒 Backing up SSL certificates...');
  let sslCount = 0;
  SSL_FILES.forEach(file => {
    const sourcePath = path.join(__dirname, file);
    const destPath = path.join(backupFolder, file);
    
    // Create SSL directory in backup if it doesn't exist
    const sslDir = path.dirname(destPath);
    if (!fs.existsSync(sslDir)) {
      fs.mkdirSync(sslDir, { recursive: true });
    }
    
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, destPath);
      const stats = fs.statSync(sourcePath);
      const sizeKB = (stats.size / 1024).toFixed(2);
      console.log(`🔒 Backed up ${file} (${sizeKB} KB) - SSL certificate`);
      sslCount++;
    } else {
      console.log(`⚠️  Skipped ${file} (not found)`);
    }
  });
  
  // Create backup metadata
  const allFiles = [
    ...DATA_FILES.filter(file => fs.existsSync(path.join(__dirname, file))),
    ...SENSITIVE_FILES.filter(file => fs.existsSync(path.join(__dirname, file))),
    ...SSL_FILES.filter(file => fs.existsSync(path.join(__dirname, file)))
  ];
  
  const metadata = {
    timestamp: new Date().toISOString(),
    files: allFiles,
    version: require('./package.json').version,
    backedUpCount,
    sensitiveCount,
    sslCount,
    skippedCount,
    containsSensitiveData: sensitiveCount > 0,
    containsSSL: sslCount > 0
  };
  
  fs.writeFileSync(
    path.join(backupFolder, 'backup_info.json'),
    JSON.stringify(metadata, null, 2)
  );
  
  console.log(`\n🎉 Backup completed successfully!`);
  console.log(`📂 Location: ${backupFolder}`);
  console.log(`📊 Data files backed up: ${backedUpCount}`);
  console.log(`🔐 Sensitive files backed up: ${sensitiveCount}`);
  console.log(`🔒 SSL certificates backed up: ${sslCount}`);
  if (skippedCount > 0) {
    console.log(`⚠️  Files skipped: ${skippedCount}`);
  }
  
  if (sensitiveCount > 0) {
    console.log(`\n⚠️  SECURITY WARNING:`);
    console.log(`   This backup contains sensitive API keys (.env file)`);
    console.log(`   Store this backup securely and never commit to version control!`);
  }
  
  if (sslCount > 0) {
    console.log(`\n🔒 SSL CERTIFICATE WARNING:`);
    console.log(`   This backup contains SSL certificates`);
    console.log(`   HTTPS will be restored when you restore this backup`);
    console.log(`   Store this backup securely!`);
  }
  
  // Clean up old backups (keep last 30)
  cleanOldBackups(30);
  
} catch (error) {
  console.error('❌ Backup failed:', error.message);
  process.exit(1);
}

function cleanOldBackups(keepCount) {
  try {
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(name => name.startsWith('backup_'))
      .map(name => ({
        name,
        path: path.join(BACKUP_DIR, name),
        time: fs.statSync(path.join(BACKUP_DIR, name)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time); // Sort by newest first
    
    if (backups.length > keepCount) {
      const toDelete = backups.slice(keepCount);
      toDelete.forEach(backup => {
        fs.rmSync(backup.path, { recursive: true, force: true });
        console.log(`🗑️  Removed old backup: ${backup.name}`);
      });
      console.log(`\n♻️  Cleaned up ${toDelete.length} old backup(s)`);
    }
  } catch (error) {
    console.warn('⚠️  Could not clean old backups:', error.message);
  }
}

