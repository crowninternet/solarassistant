/*
 * ═══════════════════════════════════════════════════════════════════════════
 * SOLARASSISTANT DASHBOARD - COMPREHENSIVE MONITORING SYSTEM
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * ARCHITECTURE OVERVIEW:
 * ----------------------
 * This application monitors a solar power system via MQTT and provides:
 * 1. Real-time dashboard with live data (updates every 3 seconds)
 * 2. Historical data tracking and visualization (365 days retention)
 * 3. Email alerts for battery thresholds
 * 4. Automatic battery charger control via IFTTT webhooks
 * 5. Weather integration for solar production correlation
 * 
 * DATA FLOW:
 * ----------
 * MQTT Messages → cachedData (in-memory) → historicalData (time-series)
 *                     ↓                           ↓
 *              REST API (/data)          Periodic disk save
 *                     ↓                           ↓
 *           Browser Dashboard              data_history.json
 * 
 * KEY DEPENDENCIES:
 * -----------------
 * - Express: Web server for dashboard and REST API
 * - MQTT: Subscribe to SolarAssistant real-time data stream
 * - SendGrid: Email alerts for battery levels and charger events
 * - File System: Persist historical data and settings across restarts
 * 
 * CRITICAL STATE MANAGEMENT:
 * --------------------------
 * - cachedData: Latest MQTT value for each topic (real-time display)
 * - historicalData: Time-series arrays for charting (memory + disk)
 * - dailyStats: Daily energy totals and peak power tracking
 * - chargerState: IFTTT smart plug state (persists across restarts)
 */

// ═══════════════════════════════════════════════════════════════════════════
// DEPENDENCIES & INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express');       // Web server framework
const https = require('https');           // HTTPS server
const fs = require('fs');                 // File system operations
const mqtt = require('mqtt');             // MQTT client for SolarAssistant data
const path = require('path');             // Path utilities
const sgMail = require('@sendgrid/mail'); // Email alerts via SendGrid API
const jwt = require('jsonwebtoken');      // JWT for authentication
const bcrypt = require('bcryptjs');       // Password hashing
const cookieParser = require('cookie-parser'); // Parse cookies for JWT

// Load environment variables from .env file
require('dotenv').config();

const app = express();
app.use(express.json()); // Parse JSON request bodies
app.use(cookieParser()); // Parse cookies

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION - LOADED FROM ENVIRONMENT VARIABLES
// ═══════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3434;                              // HTTP server port
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://192.168.1.228:1883';  // SolarAssistant MQTT broker
const MQTT_TOPIC = 'solar_assistant/#';                             // Subscribe to all SolarAssistant topics

// File paths for data persistence (survives app restarts)
const HISTORY_FILE = path.join(__dirname, 'data_history.json');      // Time-series data for charts
const SETTINGS_FILE = path.join(__dirname, 'alert_settings.json');   // User-configurable alert settings
const DAILY_STATS_FILE = path.join(__dirname, 'daily_stats.json');   // Daily energy production/consumption

// Timing configuration
const SAVE_INTERVAL = 60000;            // Save to disk every 60 seconds
const DATA_RETENTION_DAYS = 365;        // Keep 1 year of historical data
const ARCHIVE_INTERVAL = 60000;         // Archive new data points every 60 seconds
const lastArchivedTime = {};            // Track last archive time per topic to prevent duplicates

// Weather API configuration (Open-Meteo - free, no API key needed)
// Used to correlate solar production with weather conditions
const WEATHER_LAT = 33.2487;            // Queen Creek, AZ (zip 85142)
const WEATHER_LON = -111.6343;
const WEATHER_UPDATE_INTERVAL = 300000; // Update weather every 5 minutes

// Topics to track for historical charts
// IMPACT: Only these topics are stored in time-series format for charting
// NOTE: Adding topics here increases memory usage and disk space
const TRACKED_TOPICS = [
  'solar_assistant/inverter_1/pv_power/state',        // Total solar production
  'solar_assistant/inverter_1/pv_power_1/state',      // Solar array 1 production
  'solar_assistant/inverter_1/pv_power_2/state',      // Solar array 2 production
  'solar_assistant/total/battery_state_of_charge/state', // Battery SOC %
  'solar_assistant/total/battery_power/state',        // Battery power (positive=charging, negative=discharging)
  'solar_assistant/inverter_1/load_power/state',      // Power consumption
  // Individual battery metrics
  'solar_assistant/battery_1/voltage/state',
  'solar_assistant/battery_2/voltage/state',
  'solar_assistant/battery_3/voltage/state',
  'solar_assistant/battery_1/current/state',
  'solar_assistant/battery_2/current/state',
  'solar_assistant/battery_3/current/state',
  'solar_assistant/battery_1/temperature/state',
  'solar_assistant/battery_2/temperature/state',
  'solar_assistant/battery_3/temperature/state',
  'solar_assistant/battery_1/state_of_charge/state',
  'solar_assistant/battery_2/state_of_charge/state',
  'solar_assistant/battery_3/state_of_charge/state',
  'solar_assistant/battery_1/power/state',
  'solar_assistant/battery_2/power/state',
  'solar_assistant/battery_3/power/state',
  // Battery totals
  'solar_assistant/total/battery_temperature/state',
  'solar_assistant/inverter_1/battery_current/state'
];

// ═══════════════════════════════════════════════════════════════════════════
// IN-MEMORY STATE - CLEARED ON APP RESTART (except what's loaded from files)
// ═══════════════════════════════════════════════════════════════════════════

// PRIMARY DATA STORE: Latest MQTT message for each topic
// USED BY: REST API endpoints, alert logic, dashboard display
// UPDATED BY: MQTT message handler (client.on('message'))
let cachedData = {};

// TIME-SERIES DATA STORE: Historical values for charting
// STRUCTURE: { 'topic/name': [{timestamp: ISO8601, value: number}, ...] }
// USED BY: /data/history endpoint, chart rendering
// LOADED FROM: HISTORY_FILE on startup
// SAVED TO: HISTORY_FILE every SAVE_INTERVAL
let historicalData = {};

// Metadata for monitoring
let lastUpdate = null;           // Last MQTT message timestamp
let connectionStatus = 'Connecting...'; // MQTT connection status for dashboard
let messageCount = 0;            // Total MQTT messages received this session

// Weather data cache (updated every 5 minutes)
// USED BY: Dashboard weather widget, solar production correlation
let weatherData = { 
  temperature: 0, 
  weatherCode: 0,      // WMO weather code (0=clear, 3=cloudy, 61=rain, etc.)
  humidity: 0, 
  windSpeed: 0, 
  cloudCover: 0,       // Percentage (0-100)
  solarRadiation: 0,   // W/m² - correlates with PV production
  lastUpdate: null 
};

// ═══════════════════════════════════════════════════════════════════════════
// ALERT SYSTEM STATE
// ═══════════════════════════════════════════════════════════════════════════
// IMPACT: Controls email alerts and automatic charger via IFTTT
// LOADED FROM: SETTINGS_FILE on startup (user-configurable via dashboard)
// SAVED TO: SETTINGS_FILE when modified via /settings POST endpoint

let alertSettings = {
  enabled: true,                   // Master switch for all email alerts
  sendgridApiKey: process.env.SENDGRID_API_KEY || '',  // Loaded from environment variables
  fromEmail: 'notify@wpsitemail.com',
  toEmail: 'john@crowninternet.com',
  lowThreshold: 50,                // Battery % - send alert when dropping below
  highThreshold: 80,               // Battery % - send recovery alert when above
  
  // Automatic Charger Control (IFTTT Smart Plug Integration)
  // RELATIONSHIP: Uses battery SOC to automatically trigger IFTTT webhooks
  // IMPACT: Sends 'battery_low' or 'battery_charged' events to IFTTT
  chargerControl: {
    enabled: false,                // Enable automatic charger control
    iftttWebhookKey: process.env.IFTTT_WEBHOOK_KEY || '',  // Loaded from environment variables
    lowThreshold: 45,              // Turn charger ON when battery drops below this
    highThreshold: 85,             // Turn charger OFF when battery reaches this
    plugName: 'Battery Charger',   // Displayed in emails
    maxTemp: 110                   // Future: temperature safety cutoff
  },
  
  // Peak Discharge Alert - Monitors discharge during peak sunlight hours
  peakDischargeAlert: {
    enabled: true,
    durationMinutes: 30
  },
  
  // Daily Summary Reports
  dailySummary: {
    enabled: true,                 // Enable daily summary emails
    sendTime: '20:00',            // Send at 8:00 PM (24-hour format)
    timezone: 'America/Phoenix'   // Timezone for scheduling
  }
};

// ALERT STATE TRACKING - Prevents duplicate alerts
// UPDATED BY: checkAlerts() function when thresholds crossed
// USED BY: sendEmailAlert() to implement cooldown logic
let alertState = {
  belowThreshold: false,  // True if battery is currently below low threshold
  lastAlertTime: null,    // Timestamp of last alert sent (prevents spam)
  lastAlertType: null     // 'low' or 'recovered' - prevents duplicate alerts
};

// CHARGER STATE - Tracks IFTTT smart plug status
// CRITICAL: Persists across app restarts via DAILY_STATS_FILE
// IMPACT: Prevents duplicate IFTTT triggers when app restarts
// UPDATED BY: controlBatteryCharger() function
let chargerState = {
  isOn: false,           // Current charger state (synced with IFTTT plug)
  lastAction: null,      // 'ON' or 'OFF'
  lastActionTime: null,  // Timestamp of last IFTTT trigger
  lastSOC: null          // Battery SOC when last action taken
};

// Alert history for dashboard display (last 50 alerts)
// RELATIONSHIP: Displayed in Settings modal on dashboard
let alertHistory = [];

// PEAK DISCHARGE MONITORING - Tracks battery discharge during peak sunlight hours
// PURPOSE: Alert when battery is discharging during high solar production times
let peakDischargeState = {
  isDischarging: false,
  dischargeStartTime: null,
  alertSent: false,
  lastAlertTime: null
};

// ═══════════════════════════════════════════════════════════════════════════
// DAILY STATISTICS TRACKING
// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE: Calculate daily energy production/consumption deltas
// RESETS: Every day at midnight (checked by checkDayRollover function)
// PERSISTED: DAILY_STATS_FILE (survives app restarts during same day)
// IMPACT: Used by dashboard to show "today's" energy statistics

let dailyStats = {
  date: new Date().toDateString(),
  
  // Starting values (captured at start of day or app startup)
  // RELATIONSHIP: Compared with current cumulative values to get daily totals
  pvEnergyStart: null,           // kWh - solar energy at day start
  loadEnergyStart: null,         // kWh - load consumption at day start
  batteryEnergyInStart: null,    // kWh - battery charge at day start
  batteryEnergyOutStart: null,   // kWh - battery discharge at day start
  
  // Peak tracking
  peakPower: { value: 0, time: null },  // Highest solar power today
  peakPowerHourly: {}                    // Peak power per hour {hour: watts}
};

// ═══════════════════════════════════════════════════════════════════════════
// FILE PERSISTENCE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE: Save/load state across app restarts
// CALLED: On startup and periodically via setInterval

/**
 * Load daily stats from file
 * RELATIONSHIP: Loads dailyStats and chargerState from disk
 * IMPACT: Preserves charger state across app restarts (prevents duplicate IFTTT triggers)
 * CALLED BY: Startup sequence (bottom of file)
 */
function loadDailyStats() {
  try {
    if (fs.existsSync(DAILY_STATS_FILE)) {
      const data = fs.readFileSync(DAILY_STATS_FILE, 'utf8');
      const savedStats = JSON.parse(data);
      
      // Only load if it's the same day
      if (savedStats.date === new Date().toDateString()) {
        dailyStats = savedStats;
        console.log('📊 Loaded daily stats from file');
        
        // Load charger state (persists across app restarts)
        if (savedStats.chargerState) {
          chargerState = { ...chargerState, ...savedStats.chargerState };
          console.log(`🔌 Loaded charger state: ${chargerState.isOn ? 'ON' : 'OFF'}`);
        }
      } else {
        console.log('📊 New day detected, starting fresh daily stats');
        // Reset charger state on new day
        chargerState = {
          isOn: false,
          lastAction: null,
          lastActionTime: null,
          lastSOC: null
        };
      }
    }
  } catch (error) {
    console.error('❌ Error loading daily stats:', error.message);
  }
}

/**
 * Save daily stats to file
 */
function saveDailyStats() {
  try {
    // Include charger state in daily stats for persistence
    const statsToSave = {
      ...dailyStats,
      chargerState: chargerState
    };
    fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify(statsToSave, null, 2));
  } catch (error) {
    console.error('❌ Error saving daily stats:', error.message);
  }
}

/**
 * Load alert settings from file
 */
function loadAlertSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const savedSettings = JSON.parse(data);
      
      // Merge saved settings with defaults
      alertSettings = { ...alertSettings, ...savedSettings };
      
      // Always prioritize environment variables for API keys (security)
      if (process.env.SENDGRID_API_KEY) {
        alertSettings.sendgridApiKey = process.env.SENDGRID_API_KEY;
      }
      if (process.env.IFTTT_WEBHOOK_KEY && alertSettings.chargerControl) {
        alertSettings.chargerControl.iftttWebhookKey = process.env.IFTTT_WEBHOOK_KEY;
      }
      
      console.log('📧 Loaded alert settings from file');
    }
  } catch (error) {
    console.error('❌ Error loading alert settings:', error.message);
  }
}

/**
 * Save alert settings to file
 * IMPACT: Persists user settings from dashboard (email addresses, thresholds)
 * CALLED BY: POST /settings endpoint when user modifies settings
 * NOTE: API keys are excluded from save - they should only be in .env file
 */
function saveAlertSettings() {
  try {
    // Create a copy without sensitive API keys (they should only be in .env)
    const settingsToSave = {
      ...alertSettings,
      sendgridApiKey: undefined,  // Don't save to file - use .env
      chargerControl: {
        ...alertSettings.chargerControl,
        iftttWebhookKey: undefined  // Don't save to file - use .env
      }
    };
    
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsToSave, null, 2));
    console.log('💾 Saved alert settings (API keys excluded - stored in .env)');
  } catch (error) {
    console.error('❌ Error saving alert settings:', error.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EMAIL ALERT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE: Send notifications for battery thresholds and IFTTT events
// DEPENDENCIES: SendGrid API (requires valid API key in alertSettings)

/**
 * Send email alert via SendGrid
 * USED BY: checkAlerts(), controlBatteryCharger(), test charger endpoint
 * IMPACT: Sends formatted HTML/text email to configured address
 * @param {string} subject - Email subject line
 * @param {string} message - Plain text message body (converted to HTML)
 * @returns {boolean} - True if email sent successfully
 */
async function sendEmailAlert(subject, message) {
  if (!alertSettings.enabled || !alertSettings.sendgridApiKey) {
    console.log('📧 Alerts disabled or no API key configured');
    return false;
  }

  try {
    sgMail.setApiKey(alertSettings.sendgridApiKey);
    
    const msg = {
      to: alertSettings.toEmail,
      from: alertSettings.fromEmail,
      subject: subject,
      text: message,
      html: `<div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2 style="color: #667eea;">${subject}</h2>
        <p style="font-size: 16px;">${message}</p>
        <hr style="margin: 20px 0; border: none; border-top: 1px solid #e0e0e0;">
        <p style="color: #999; font-size: 12px;">SolarAssistant Dashboard Alert System</p>
      </div>`
    };
    
    await sgMail.send(msg);
    console.log(`📧 Alert sent: ${subject}`);
    return true;
  } catch (error) {
    console.error('❌ Error sending email alert:', error.message);
    return false;
  }
}

/**
 * Check battery SOC and send alerts if thresholds are crossed
 */
async function checkBatteryAlerts(soc) {
  if (!alertSettings.enabled) return;
  
  const socValue = parseFloat(soc);
  if (isNaN(socValue)) return;
  
  // Check if SOC dropped below low threshold
  if (!alertState.belowThreshold && socValue < alertSettings.lowThreshold) {
    alertState.belowThreshold = true;
    alertState.lastAlertTime = new Date();
    alertState.lastAlertType = 'low';
    
    // Add to alert history
    alertHistory.unshift({
      type: 'low',
      message: `Battery dropped to ${socValue}%`,
      threshold: alertSettings.lowThreshold,
      value: socValue,
      timestamp: new Date().toISOString()
    });
    if (alertHistory.length > 50) alertHistory.pop();
    
    await sendEmailAlert(
      '⚠️ Low Battery Alert',
      `Battery State of Charge has dropped to ${socValue}% (below ${alertSettings.lowThreshold}% threshold).\\n\\nTime: ${new Date().toLocaleString()}`
    );
    
    console.log(`⚠️ LOW BATTERY ALERT: SOC at ${socValue}%`);
  }
  
  // Check if SOC recovered above high threshold
  if (alertState.belowThreshold && socValue > alertSettings.highThreshold) {
    alertState.belowThreshold = false;
    alertState.lastAlertTime = new Date();
    alertState.lastAlertType = 'recovered';
    
    // Add to alert history
    alertHistory.unshift({
      type: 'recovered',
      message: `Battery recovered to ${socValue}%`,
      threshold: alertSettings.highThreshold,
      value: socValue,
      timestamp: new Date().toISOString()
    });
    if (alertHistory.length > 50) alertHistory.pop();
    
    await sendEmailAlert(
      '✅ Battery Recovered',
      `Battery State of Charge has recovered to ${socValue}% (above ${alertSettings.highThreshold}% threshold).\\n\\nTime: ${new Date().toLocaleString()}`
    );
    
    console.log(`✅ BATTERY RECOVERED: SOC at ${socValue}%`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DAILY SUMMARY REPORT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE: Send comprehensive daily summary reports via email
// SCHEDULED: Daily at 8:00 PM (configurable in alertSettings.dailySummary)

/**
 * Calculate daily energy statistics from historical data
 */
function calculateDailyStats() {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  
  const stats = {
    date: today.toDateString(),
    solarEnergy: { total: 0, array1: 0, array2: 0 },
    loadEnergy: 0,
    batteryEnergy: { in: 0, out: 0, net: 0 },
    peakPower: { solar: 0, load: 0, solarTime: null, loadTime: null },
    batterySOC: { start: null, end: null, peak: 0, low: 100 },
    weather: weatherData,
    systemHealth: {
      uptime: 0,
      dataPoints: 0,
      connectionStatus: connectionStatus
    },
    efficiency: 0
  };
  
  // Calculate energy from power data (integrate over time)
  TRACKED_TOPICS.forEach(topic => {
    if (!historicalData[topic]) return;
    
    const data = historicalData[topic].filter(point => {
      const pointTime = new Date(point.timestamp);
      return pointTime >= startOfDay && pointTime < endOfDay;
    });
    
    if (data.length === 0) return;
    
    // Calculate energy by integrating power over time
    let energy = 0;
    let peakPower = 0;
    let peakTime = null;
    
    for (let i = 1; i < data.length; i++) {
      const prevPoint = data[i - 1];
      const currPoint = data[i];
      const timeDiff = (new Date(currPoint.timestamp) - new Date(prevPoint.timestamp)) / 3600000; // hours
      const avgPower = (parseFloat(prevPoint.value) + parseFloat(currPoint.value)) / 2;
      
      energy += avgPower * timeDiff / 1000; // Convert to kWh
      
      if (parseFloat(currPoint.value) > peakPower) {
        peakPower = parseFloat(currPoint.value);
        peakTime = currPoint.timestamp;
      }
    }
    
    // Assign to appropriate category
    if (topic.includes('pv_power/state') && !topic.includes('pv_power_1') && !topic.includes('pv_power_2')) {
      stats.solarEnergy.total = Math.round(energy * 100) / 100;
      stats.peakPower.solar = Math.round(peakPower);
      stats.peakPower.solarTime = peakTime;
    } else if (topic.includes('pv_power_1/state')) {
      stats.solarEnergy.array1 = Math.round(energy * 100) / 100;
    } else if (topic.includes('pv_power_2/state')) {
      stats.solarEnergy.array2 = Math.round(energy * 100) / 100;
    } else if (topic.includes('load_power/state')) {
      stats.loadEnergy = Math.round(energy * 100) / 100;
      stats.peakPower.load = Math.round(peakPower);
      stats.peakPower.loadTime = peakTime;
    } else if (topic.includes('battery_state_of_charge/state')) {
      // Get battery SOC data
      if (data.length > 0) {
        stats.batterySOC.start = Math.round(parseFloat(data[0].value));
        stats.batterySOC.end = Math.round(parseFloat(data[data.length - 1].value));
        
        data.forEach(point => {
          const soc = parseFloat(point.value);
          if (soc > stats.batterySOC.peak) stats.batterySOC.peak = Math.round(soc);
          if (soc < stats.batterySOC.low) stats.batterySOC.low = Math.round(soc);
        });
      }
    }
  });
  
  // Calculate net energy balance
  const netBalance = stats.solarEnergy.total - stats.loadEnergy;
  stats.netBalance = Math.round(netBalance * 100) / 100;
  
  // Calculate efficiency
  if (stats.loadEnergy > 0) {
    stats.efficiency = Math.round((stats.solarEnergy.total / stats.loadEnergy) * 100);
  }
  
  // Calculate system uptime (approximate from data points)
  stats.systemHealth.dataPoints = Object.values(historicalData).reduce((total, topicData) => {
    return total + (topicData ? topicData.length : 0);
  }, 0);
  
  return stats;
}

/**
 * Generate HTML content for daily summary email
 */
function generateDailySummaryHTML(stats) {
  const date = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  
  const weatherIcon = getWeatherIcon(stats.weather?.weatherCode || 0);
  const weatherDesc = getWeatherDescription(stats.weather?.weatherCode || 0);
  
  const socChange = stats.batterySOC.end - stats.batterySOC.start;
  const socChangeText = socChange > 0 ? `+${socChange}%` : `${socChange}%`;
  const socChangeColor = socChange > 0 ? '#27ae60' : socChange < 0 ? '#e74c3c' : '#3498db';
  
  const efficiencyColor = stats.efficiency >= 100 ? '#27ae60' : stats.efficiency >= 80 ? '#f39c12' : '#e74c3c';
  const efficiencyText = stats.efficiency >= 100 ? 'Excellent' : stats.efficiency >= 80 ? 'Good' : 'Needs Improvement';
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Daily Solar Summary - ${date}</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
        <h1 style="margin: 0; font-size: 28px;">☀️ Solar Assistant</h1>
        <h2 style="margin: 10px 0 0 0; font-size: 20px; opacity: 0.9;">Daily Summary Report</h2>
        <p style="margin: 15px 0 0 0; font-size: 16px; opacity: 0.8;">${date}</p>
      </div>
      
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #e9ecef;">
        
        <!-- Quick Stats Summary -->
        <div style="background: white; padding: 25px; border-radius: 8px; margin-bottom: 25px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <h3 style="margin-top: 0; color: #667eea; border-bottom: 2px solid #667eea; padding-bottom: 10px;">📊 Today's Summary</h3>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 20px;">
            <div style="text-align: center; padding: 15px; background: #e8f5e8; border-radius: 8px;">
              <div style="font-size: 24px; font-weight: bold; color: #27ae60;">${stats.solarEnergy.total} kWh</div>
              <div style="color: #666; font-size: 14px;">☀️ Solar Generated</div>
            </div>
            <div style="text-align: center; padding: 15px; background: #e3f2fd; border-radius: 8px;">
              <div style="font-size: 24px; font-weight: bold; color: #3498db;">${stats.loadEnergy} kWh</div>
              <div style="color: #666; font-size: 14px;">⚡ Energy Consumed</div>
            </div>
            <div style="text-align: center; padding: 15px; background: #fff3e0; border-radius: 8px;">
              <div style="font-size: 24px; font-weight: bold; color: #f39c12;">${stats.netBalance > 0 ? '+' : ''}${stats.netBalance} kWh</div>
              <div style="color: #666; font-size: 14px;">⚖️ Net Balance</div>
            </div>
            <div style="text-align: center; padding: 15px; background: #fce4ec; border-radius: 8px;">
              <div style="font-size: 24px; font-weight: bold; color: ${efficiencyColor};">${stats.efficiency}%</div>
              <div style="color: #666; font-size: 14px;">🎯 Efficiency</div>
            </div>
          </div>
        </div>
        
        <!-- Solar Performance -->
        <div style="background: white; padding: 25px; border-radius: 8px; margin-bottom: 25px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <h3 style="margin-top: 0; color: #f39c12; border-bottom: 2px solid #f39c12; padding-bottom: 10px;">☀️ Solar Performance</h3>
          <div style="margin-top: 20px;">
            <p><strong>Total Solar Energy:</strong> ${stats.solarEnergy.total} kWh</p>
            <p><strong>Array 1:</strong> ${stats.solarEnergy.array1} kWh</p>
            <p><strong>Array 2:</strong> ${stats.solarEnergy.array2} kWh</p>
            <p><strong>Peak Power:</strong> ${stats.peakPower.solar} W ${stats.peakPower.solarTime ? 'at ' + new Date(stats.peakPower.solarTime).toLocaleTimeString() : ''}</p>
          </div>
        </div>
        
        <!-- Battery Status -->
        <div style="background: white; padding: 25px; border-radius: 8px; margin-bottom: 25px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <h3 style="margin-top: 0; color: #27ae60; border-bottom: 2px solid #27ae60; padding-bottom: 10px;">🔋 Battery Status</h3>
          <div style="margin-top: 20px;">
            <p><strong>Starting SOC:</strong> ${stats.batterySOC.start || 'N/A'}%</p>
            <p><strong>Ending SOC:</strong> ${stats.batterySOC.end || 'N/A'}%</p>
            <p><strong>Daily Change:</strong> <span style="color: ${socChangeColor}; font-weight: bold;">${socChangeText}</span></p>
            <p><strong>Peak SOC:</strong> ${stats.batterySOC.peak}%</p>
            <p><strong>Lowest SOC:</strong> ${stats.batterySOC.low}%</p>
          </div>
        </div>
        
        <!-- Weather & System Health -->
        <div style="background: white; padding: 25px; border-radius: 8px; margin-bottom: 25px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <h3 style="margin-top: 0; color: #3498db; border-bottom: 2px solid #3498db; padding-bottom: 10px;">🌤️ Weather & System Health</h3>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 20px;">
            <div>
              <h4 style="color: #667eea; margin-bottom: 10px;">Weather Conditions</h4>
              <p><strong>Conditions:</strong> ${weatherIcon} ${weatherDesc}</p>
              ${stats.weather ? `
                <p><strong>Temperature:</strong> ${stats.weather.temperature}°F</p>
                <p><strong>Humidity:</strong> ${stats.weather.humidity}%</p>
                <p><strong>Solar Irradiance:</strong> ${stats.weather.solarRadiation} W/m²</p>
              ` : '<p>Weather data unavailable</p>'}
            </div>
            <div>
              <h4 style="color: #667eea; margin-bottom: 10px;">System Status</h4>
              <p><strong>Connection:</strong> <span style="color: ${stats.systemHealth.connectionStatus === 'Connected' ? '#27ae60' : '#e74c3c'}">${stats.systemHealth.connectionStatus}</span></p>
              <p><strong>Data Points:</strong> ${stats.systemHealth.dataPoints.toLocaleString()}</p>
              <p><strong>Efficiency Rating:</strong> <span style="color: ${efficiencyColor}; font-weight: bold;">${efficiencyText}</span></p>
            </div>
          </div>
        </div>
        
        <!-- Insights & Recommendations -->
        <div style="background: white; padding: 25px; border-radius: 8px; margin-bottom: 25px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <h3 style="margin-top: 0; color: #8e44ad; border-bottom: 2px solid #8e44ad; padding-bottom: 10px;">💡 Insights & Recommendations</h3>
          <div style="margin-top: 20px;">
            ${generateDailyInsights(stats)}
          </div>
        </div>
        
        <!-- Dashboard Link -->
        <div style="text-align: center; margin-top: 30px;">
          <a href="https://localhost:3434" style="background: #667eea; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">View Full Dashboard</a>
        </div>
        
      </div>
      
      <div style="text-align: center; margin-top: 30px; padding: 20px; color: #666; font-size: 12px;">
        <p>Solar Assistant Dashboard - Automated Daily Report</p>
        <p>Generated at ${new Date().toLocaleString()}</p>
      </div>
    </body>
    </html>
  `;
}

/**
 * Generate daily insights and recommendations
 */
function generateDailyInsights(stats) {
  const insights = [];
  
  // Efficiency insights
  if (stats.efficiency >= 120) {
    insights.push('🎉 Excellent efficiency! Your solar system is generating significantly more than you\'re consuming.');
  } else if (stats.efficiency >= 100) {
    insights.push('✅ Great efficiency! You\'re generating as much or more than you\'re consuming.');
  } else if (stats.efficiency >= 80) {
    insights.push('👍 Good efficiency. Consider optimizing load timing to better utilize solar production.');
  } else {
    insights.push('⚠️ Lower efficiency detected. Consider reviewing your energy consumption patterns.');
  }
  
  // Battery insights
  if (stats.batterySOC.end > stats.batterySOC.start) {
    insights.push('🔋 Battery charged throughout the day - great solar utilization!');
  } else if (stats.batterySOC.end < stats.batterySOC.start) {
    insights.push('⚡ Battery discharged during the day. Consider reducing evening consumption.');
  }
  
  // Weather insights
  if (stats.weather && stats.weather.solarRadiation > 800) {
    insights.push('☀️ Excellent solar conditions today with high irradiance.');
  } else if (stats.weather && stats.weather.solarRadiation < 400) {
    insights.push('☁️ Cloudy conditions reduced solar production. Tomorrow should be better!');
  }
  
  // Peak power insights
  if (stats.peakPower.solar > 2000) {
    insights.push('🚀 Outstanding peak power generation! Your panels are performing excellently.');
  }
  
  return insights.map(insight => `<p style="margin: 10px 0;">${insight}</p>`).join('');
}

/**
 * Get weather description from weather code
 */
function getWeatherDescription(weatherCode) {
  const descriptions = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    71: 'Slight snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail'
  };
  return descriptions[weatherCode] || 'Unknown';
}

/**
 * Send daily summary report
 */
async function sendDailySummaryReport() {
  if (!alertSettings.dailySummary.enabled || !alertSettings.enabled) {
    console.log('📧 Daily summary disabled or alerts disabled');
    return false;
  }
  
  try {
    console.log('📊 Generating daily summary report...');
    
    const stats = calculateDailyStats();
    const htmlContent = generateDailySummaryHTML(stats);
    const subject = `📊 Daily Solar Summary - ${stats.date}`;
    
    // Send the email
    if (alertSettings.sendgridApiKey) {
      sgMail.setApiKey(alertSettings.sendgridApiKey);
      
      const msg = {
        to: alertSettings.toEmail,
        from: alertSettings.fromEmail,
        subject: subject,
        html: htmlContent
      };
      
      await sgMail.send(msg);
      console.log('✅ Daily summary report sent successfully');
      
      // Add to alert history
      alertHistory.unshift({
        type: 'daily_summary',
        message: `Daily summary sent for ${stats.date}`,
        timestamp: new Date().toISOString()
      });
      if (alertHistory.length > 50) alertHistory.pop();
      
      return true;
    } else {
      console.log('❌ No SendGrid API key configured for daily summary');
      return false;
    }
  } catch (error) {
    console.error('❌ Error sending daily summary report:', error.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTOMATIC CHARGER CONTROL (IFTTT INTEGRATION)
// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE: Automatically turn charger ON/OFF based on battery SOC
// FLOW: MQTT SOC update → This function → IFTTT webhook → Smart Plug → Charger
// IMPACT: Prevents battery over-discharge by automatically charging
// 
// DEPENDENCY CHAIN:
// 1. MQTT message: 'solar_assistant/total/battery_state_of_charge/state'
// 2. → archiveData() function calls this
// 3. → HTTP POST to https://maker.ifttt.com/trigger/{event}/with/key/{key}
// 4. → IFTTT applet turns TP-Link smart plug ON/OFF
// 5. → Email alert sent via sendEmailAlert()
// 
// STATE MANAGEMENT:
// - chargerState tracks ON/OFF to prevent duplicate triggers
// - Uses hysteresis (different ON/OFF thresholds) to prevent rapid cycling
// - State persists across app restarts via dailyStats.chargerState

/**
 * Control battery charger via IFTTT webhook
 * @param {number} soc - Battery State of Charge percentage (0-100)
 * CALLED BY: archiveData() when SOC topic is updated
 * TRIGGERS: IFTTT 'battery_low' or 'battery_charged' webhook events
 */
async function controlBatteryCharger(soc) {
  if (!alertSettings.chargerControl?.enabled || !alertSettings.chargerControl?.iftttWebhookKey) {
    return;
  }

  const { lowThreshold, highThreshold, iftttWebhookKey, plugName, maxTemp } = alertSettings.chargerControl;
  const socValue = parseFloat(soc);
  const now = Date.now();
  
  if (isNaN(socValue)) return;
  
  // Check battery temperature - disable charging if too hot
  const batteryTemp = parseFloat(cachedData['solar_assistant/total/battery_temperature/state']?.value);
  if (!isNaN(batteryTemp) && batteryTemp > maxTemp) {
    if (chargerState.isOn) {
      console.log(`🌡️ Battery temperature too high (${batteryTemp}°F > ${maxTemp}°F) - keeping charger OFF for safety`);
    }
    return;
  }
  
  // Prevent rapid toggling (minimum 5 minutes between actions)
  if (chargerState.lastActionTime && (now - chargerState.lastActionTime) < 300000) {
    return;
  }
  
  // Hysteresis: Add 2% buffer to prevent oscillation
  const effectiveLowThreshold = lowThreshold;
  const effectiveHighThreshold = highThreshold;

  try {
    // Turn ON charger when SOC is low
    if (socValue <= effectiveLowThreshold && !chargerState.isOn) {
      const response = await fetch(`https://maker.ifttt.com/trigger/battery_low/with/key/${iftttWebhookKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          value1: socValue,
          value2: plugName,
          value3: new Date().toLocaleString()
        })
      });
      
      if (response.ok) {
        chargerState.isOn = true;
        chargerState.lastAction = 'ON';
        chargerState.lastActionTime = now;
        chargerState.lastSOC = socValue;
        console.log(`🔌 CHARGER TURNED ON - Battery at ${socValue}% (threshold: ${effectiveLowThreshold}%)`);
        
        // Send email notification
        await sendEmailAlert(
          '🔌 Battery Charger Activated',
          `Your battery charger has been automatically turned ON via IFTTT.\n\nIFTTT Trigger Event: battery_low\nCurrent Battery SOC: ${socValue}%\nLow Threshold: ${effectiveLowThreshold}%\nPlug: ${plugName}\nTime: ${new Date().toLocaleString()}\n\nThe charger will automatically turn off when battery reaches ${effectiveHighThreshold}%.`
        );
      } else {
        console.error(`❌ Failed to turn ON charger - IFTTT responded with status ${response.status}`);
        await sendEmailAlert(
          '⚠️ Battery Charger Control Failed',
          `Failed to turn ON the battery charger via IFTTT.\n\nIFTTT Trigger Event: battery_low\nHTTP Status: ${response.status}\nCurrent Battery SOC: ${socValue}%\nLow Threshold: ${effectiveLowThreshold}%\nTime: ${new Date().toLocaleString()}\n\nPlease check your IFTTT configuration and webhook key.`
        );
      }
    }
    
    // Turn OFF charger when SOC is high enough
    else if (socValue >= effectiveHighThreshold && chargerState.isOn) {
      const response = await fetch(`https://maker.ifttt.com/trigger/battery_charged/with/key/${iftttWebhookKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          value1: socValue,
          value2: plugName,
          value3: new Date().toLocaleString()
        })
      });
      
      if (response.ok) {
        chargerState.isOn = false;
        chargerState.lastAction = 'OFF';
        chargerState.lastActionTime = now;
        chargerState.lastSOC = socValue;
        console.log(`🔌 CHARGER TURNED OFF - Battery at ${socValue}% (threshold: ${effectiveHighThreshold}%)`);
        
        // Send email notification
        await sendEmailAlert(
          '✅ Battery Charger Deactivated',
          `Your battery charger has been automatically turned OFF via IFTTT.\n\nIFTTT Trigger Event: battery_charged\nCurrent Battery SOC: ${socValue}%\nHigh Threshold: ${effectiveHighThreshold}%\nPlug: ${plugName}\nTime: ${new Date().toLocaleString()}\n\nBattery is now fully charged.`
        );
      } else {
        console.error(`❌ Failed to turn OFF charger - IFTTT responded with status ${response.status}`);
        await sendEmailAlert(
          '⚠️ Battery Charger Control Failed',
          `Failed to turn OFF the battery charger via IFTTT.\n\nIFTTT Trigger Event: battery_charged\nHTTP Status: ${response.status}\nCurrent Battery SOC: ${socValue}%\nHigh Threshold: ${effectiveHighThreshold}%\nTime: ${new Date().toLocaleString()}\n\nPlease check your IFTTT configuration and webhook key.`
        );
      }
    }
  } catch (error) {
    console.error('❌ Error controlling charger via IFTTT:', error.message);
    await sendEmailAlert(
      '❌ Battery Charger Control Error',
      `An error occurred while trying to control the battery charger via IFTTT.\n\nError: ${error.message}\nCurrent Battery SOC: ${soc}%\nTime: ${new Date().toLocaleString()}\n\nPlease check your network connection and IFTTT configuration.`
    );
  }
}

// Monitor battery discharge during peak sunlight hours
async function monitorPeakDischarge(batteryPower) {
  if (!alertSettings.peakDischargeAlert?.enabled) return;
  
  const now = Date.now();
  const batteryPowerValue = parseFloat(batteryPower);
  if (isNaN(batteryPowerValue)) return;
  
  const inPeakHours = isWithinPeakHours();
  const peakHours = getSeasonalPeakHours();
  const isDischarging = batteryPowerValue < -50;
  
  if (inPeakHours && isDischarging) {
    if (!peakDischargeState.isDischarging) {
      peakDischargeState.isDischarging = true;
      peakDischargeState.dischargeStartTime = now;
      peakDischargeState.alertSent = false;
      console.log('⚠️ PEAK DISCHARGE STARTED: Battery discharging during peak hours');
    } else {
      const dischargeDuration = now - peakDischargeState.dischargeStartTime;
      const durationMinutes = Math.floor(dischargeDuration / 60000);
      
      if (durationMinutes >= 30 && !peakDischargeState.alertSent) {
        peakDischargeState.alertSent = true;
        peakDischargeState.lastAlertTime = now;
        
        const solarPower = parseFloat(cachedData['solar_assistant/inverter_1/pv_power/state']?.value) || 0;
        const loadPower = parseFloat(cachedData['solar_assistant/inverter_1/load_power/state']?.value) || 0;
        const batterySOC = parseFloat(cachedData['solar_assistant/total/battery_soc/state']?.value) || 0;
        
        const startTimeStr = new Date(peakDischargeState.dischargeStartTime).toLocaleTimeString();
        const peakStartTime = formatHour(peakHours.startHour);
        const peakEndTime = formatHour(peakHours.endHour);
        
        console.log('🚨 PEAK DISCHARGE ALERT: Battery discharging for ' + durationMinutes + ' minutes during peak hours');
        
        let msg = 'Your battery has been discharging for ' + durationMinutes + ' minutes during peak sunlight hours.\n\n';
        msg += '⏰ Discharge Period:\n';
        msg += '• Started: ' + startTimeStr + '\n';
        msg += '• Duration: ' + durationMinutes + ' minutes\n\n';
        msg += '☀️ Peak Hours (' + peakHours.season + '): ' + peakStartTime + ' - ' + peakEndTime + '\n\n';
        msg += '📊 Current Status:\n';
        msg += '• Battery Discharge: ' + Math.abs(Math.round(batteryPowerValue)) + 'W\n';
        msg += '• Solar Production: ' + Math.round(solarPower) + 'W\n';
        msg += '• Load: ' + Math.round(loadPower) + 'W\n';
        msg += '• Battery SOC: ' + batterySOC + '%\n\n';
        msg += '💡 Possible Causes:\n';
        if (solarPower < 500) msg += '• Low solar production - check panels\n';
        if (loadPower > solarPower + 1000) msg += '• High load exceeding production\n';
        if (weatherData.cloudCover > 70) msg += '• Heavy cloud cover\n';
        msg += '\nTime: ' + new Date().toLocaleString();
        
        await sendEmailAlert('⚠️ Battery Discharging During Peak Hours', msg);
        
        alertHistory.unshift({
          type: 'peak_discharge',
          message: 'Battery discharged for ' + durationMinutes + 'min during peak hours',
          time: new Date().toISOString(),
          details: {
            dischargePower: Math.round(batteryPowerValue),
            solarPower: Math.round(solarPower),
            loadPower: Math.round(loadPower),
            duration: durationMinutes
          }
        });
        if (alertHistory.length > 50) alertHistory.pop();
      }
    }
  } else {
    if (peakDischargeState.isDischarging) {
      peakDischargeState.isDischarging = false;
      peakDischargeState.dischargeStartTime = null;
      peakDischargeState.alertSent = false;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DAILY STATISTICS & UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE: Track daily energy totals and calculate dashboard metrics
// RELATIONSHIP: Uses cachedData and historicalData to compute stats

/**
 * Update daily statistics (energy totals, peak power)
 * CALLED BY: archiveData() when tracked topics receive new values
 * IMPACT: Updates dailyStats which is displayed on dashboard
 * @param {string} topic - MQTT topic name
 * @param {number} value - Topic value (watts or percentage)
 */
function updateDailyStats(topic, value) {
  const today = new Date().toDateString();
  
  // Reset stats if it's a new day
  if (dailyStats.date !== today) {
    dailyStats = {
      date: today,
      pvEnergyStart: null,
      loadEnergyStart: null,
      batteryEnergyInStart: null,
      batteryEnergyOutStart: null,
      peakPower: { value: 0, time: null },
      peakPowerHourly: {}
    };
  }
  
  // Track energy baselines (cumulative values from MQTT)
  if (topic === 'solar_assistant/total/pv_energy/state' && dailyStats.pvEnergyStart === null) {
    dailyStats.pvEnergyStart = parseFloat(value);
  }
  if (topic === 'solar_assistant/total/load_energy/state' && dailyStats.loadEnergyStart === null) {
    dailyStats.loadEnergyStart = parseFloat(value);
  }
  if (topic === 'solar_assistant/total/battery_energy_in/state' && dailyStats.batteryEnergyInStart === null) {
    dailyStats.batteryEnergyInStart = parseFloat(value);
  }
  if (topic === 'solar_assistant/total/battery_energy_out/state' && dailyStats.batteryEnergyOutStart === null) {
    dailyStats.batteryEnergyOutStart = parseFloat(value);
  }
  
  // Track peak solar power
  if (topic === 'solar_assistant/inverter_1/pv_power/state') {
    const power = parseFloat(value);
    if (power > dailyStats.peakPower.value) {
      dailyStats.peakPower.value = power;
      dailyStats.peakPower.time = new Date();
    }
    
    // Track hourly peaks
    const hour = new Date().getHours();
    if (!dailyStats.peakPowerHourly[hour] || power > dailyStats.peakPowerHourly[hour]) {
      dailyStats.peakPowerHourly[hour] = power;
    }
  }
}

/**
 * Get daily energy produced (kWh)
 */
function getDailyEnergyProduced() {
  const currentEnergy = cachedData['solar_assistant/total/pv_energy/state']?.value;
  if (currentEnergy) {
    const currentValue = parseFloat(currentEnergy);
    
    // Initialize baseline if not set
    if (dailyStats.pvEnergyStart === null) {
      // Try to find the earliest value from today in historical data
      const topic = 'solar_assistant/inverter_1/pv_power/state';
      if (historicalData[topic] && historicalData[topic].length > 0) {
        const today = new Date().toDateString();
        const todayData = historicalData[topic].filter(point => {
          return new Date(point.timestamp).toDateString() === today;
        });
        
        if (todayData.length > 0) {
          // Estimate energy from power data (integrate power over time)
          let totalEnergy = 0;
          for (let i = 1; i < todayData.length; i++) {
            const timeDiff = (new Date(todayData[i].timestamp) - new Date(todayData[i-1].timestamp)) / 3600000; // hours
            const avgPower = (todayData[i].value + todayData[i-1].value) / 2; // watts
            totalEnergy += (avgPower * timeDiff) / 1000; // kWh
          }
          
          // Set baseline to current minus calculated
          dailyStats.pvEnergyStart = currentValue - totalEnergy;
          console.log(`📊 Estimated daily baseline: ${dailyStats.pvEnergyStart.toFixed(2)} kWh (today's production: ${totalEnergy.toFixed(2)} kWh)`);
        } else {
          dailyStats.pvEnergyStart = currentValue;
        }
      } else {
        dailyStats.pvEnergyStart = currentValue;
      }
    }
    
    return Math.max(0, currentValue - dailyStats.pvEnergyStart).toFixed(2);
  }
  return '0.00';
}

/**
 * Get daily energy consumed (kWh) - cumulative since dashboard start
 */
function getDailyEnergyConsumed() {
  const currentEnergy = cachedData['solar_assistant/total/load_energy/state']?.value;
  if (currentEnergy) {
    // Initialize baseline if not set
    if (dailyStats.loadEnergyStart === null) {
      dailyStats.loadEnergyStart = parseFloat(currentEnergy);
      return '0.00';
    }
    return (parseFloat(currentEnergy) - dailyStats.loadEnergyStart).toFixed(2);
  }
  return '0.00';
}

/**
 * Calculate estimated battery runtime based on power balance
 * FORMULA: (Battery Capacity * Voltage * SOC) / Net Discharge Rate = Hours
 * USED BY: Dashboard to show "X hours remaining" estimate
 * @returns {string} - Formatted runtime (e.g., "5h 23m") or "N/A"
 */
function getBatteryRuntime() {
  const soc = parseFloat(cachedData['solar_assistant/total/battery_state_of_charge/state']?.value);
  const solarPower = parseFloat(cachedData['solar_assistant/inverter_1/pv_power/state']?.value);
  const loadPower = parseFloat(cachedData['solar_assistant/inverter_1/load_power/state']?.value);
  const batteryPower = parseFloat(cachedData['solar_assistant/total/battery_power/state']?.value);
  const batteryCapacity = 300; // Total capacity in Ah (3 x 100Ah batteries)
  const batteryVoltage = parseFloat(cachedData['solar_assistant/inverter_1/battery_voltage/state']?.value) || 48;
  
  if (!isNaN(soc) && !isNaN(solarPower) && !isNaN(loadPower)) {
    // Calculate power balance (solar + external charger - load)
    const isExternalChargerOn = chargerState && chargerState.isOn;
    const externalChargerPower = (isExternalChargerOn && batteryPower > 0) ? batteryPower : 0;
    const powerBalance = solarPower + externalChargerPower - loadPower;
    
    // Calculate available energy in battery
    const availableEnergy = (batteryCapacity * batteryVoltage * soc) / 100;
    
    // If power balance is positive (charging), show indefinite runtime
    if (powerBalance > 0) {
      return 'Indefinite';
    }
    // If power balance is negative (discharging), calculate time to empty
    else if (powerBalance < 0) {
      const runtimeHours = availableEnergy / Math.abs(powerBalance);
      
      if (runtimeHours < 1) {
        return `${Math.round(runtimeHours * 60)} min`;
      } else if (runtimeHours < 24) {
        return `${runtimeHours.toFixed(1)} hrs`;
      } else {
        return `${(runtimeHours / 24).toFixed(1)} days`;
      }
    }
    // If power balance is zero (balanced), theoretically infinite runtime
    else {
      return 'Infinite';
    }
  }
  return 'N/A';
}

/**
 * Get power balance (solar - load)
 * IMPACT: Positive = battery charging, Negative = battery discharging
 * USED BY: Power Balance card on dashboard (shows with colored arrows)
 * @returns {number|string} - Power balance in watts or "N/A"
 */
function getPowerBalance() {
  const solarPower = parseFloat(cachedData['solar_assistant/inverter_1/pv_power/state']?.value);
  const loadPower = parseFloat(cachedData['solar_assistant/inverter_1/load_power/state']?.value);
  const batteryPower = parseFloat(cachedData['solar_assistant/total/battery_power/state']?.value);
  
  if (!isNaN(solarPower) && !isNaN(loadPower)) {
    // Calculate total power input: Solar + External Charger (if IFTTT triggered it ON)
    const isExternalChargerOn = chargerState && chargerState.isOn;
    const externalChargerPower = (isExternalChargerOn && batteryPower > 0) ? batteryPower : 0;
    const totalPowerInput = solarPower + externalChargerPower;
    
    return Math.round(totalPowerInput - loadPower);
  }
  return 'N/A';
}

/**
 * Get percentage of total solar power for a specific array
 * USED BY: Solar array chart on dashboard
 * @param {string} arrayType - 'array1' or 'array2'
 * @returns {number} - Percentage (0-100)
 */
function getArrayPercentage(arrayType) {
  const array1Power = parseFloat(cachedData['solar_assistant/inverter_1/pv_power_1/state']?.value) || 0;
  const array2Power = parseFloat(cachedData['solar_assistant/inverter_1/pv_power_2/state']?.value) || 0;
  const totalPower = array1Power + array2Power;
  
  if (totalPower === 0) return 0;
  
  if (arrayType === 'array1') {
    return Math.round((array1Power / totalPower) * 100);
  } else if (arrayType === 'array2') {
    return Math.round((array2Power / totalPower) * 100);
  }
  
  return 0;
}

/**
 * Get peak power for a specific array in the past 24 hours
 * USED BY: Array performance charts
 * @param {string} arrayType - 'array1' or 'array2'
 * @returns {number} - Peak power in watts
 */
function getArray24HourPeak(arrayType) {
  const topic = arrayType === 'array1' 
    ? 'solar_assistant/inverter_1/pv_power_1/state'
    : 'solar_assistant/inverter_1/pv_power_2/state';
  
  if (!historicalData[topic] || historicalData[topic].length === 0) {
    return 0;
  }
  
  const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
  const recentData = historicalData[topic].filter(point => 
    new Date(point.timestamp).getTime() > twentyFourHoursAgo
  );
  
  if (recentData.length === 0) {
    return 0;
  }
  
  return Math.max(...recentData.map(point => parseFloat(point.value) || 0));
}

/**
 * Get percentage of current power vs 24-hour peak for a specific array
 * USED BY: Array performance charts
 * @param {string} arrayType - 'array1' or 'array2'
 * @returns {number} - Percentage (0-100)
 */
function getArrayPerformancePercentage(arrayType) {
  const topic = arrayType === 'array1' 
    ? 'solar_assistant/inverter_1/pv_power_1/state'
    : 'solar_assistant/inverter_1/pv_power_2/state';
  
  const currentPower = parseFloat(cachedData[topic]?.value) || 0;
  const peakPower = getArray24HourPeak(arrayType);
  
  if (peakPower === 0) return 0;
  
  return Math.round((currentPower / peakPower) * 100);
}

/**
 * Get peak solar production power and time
 * SEARCHES: historicalData for pv_power/state topic
 * USED BY: Dashboard "Peak Production" card
 * @param {number|null} timeRangeHours - Limit search to recent hours (null = all-time)
 * @returns {string} - Formatted peak (e.g., "2.5 kW at 12:34 PM") or "N/A"
 */
function getPeakPerformance(timeRangeHours = null) {
  const topic = 'solar_assistant/inverter_1/pv_power/state';
  
  if (!historicalData[topic] || historicalData[topic].length === 0) {
    return 'N/A';
  }
  
  let dataPoints = historicalData[topic];
  
  // Filter by time range if specified
  if (timeRangeHours !== null) {
    const now = new Date();
    const startTime = new Date(now - timeRangeHours * 3600000);
    dataPoints = dataPoints.filter(point => new Date(point.timestamp) >= startTime);
  }
  
  if (dataPoints.length === 0) {
    return 'N/A';
  }
  
  // Find peak value and timestamp
  let peakValue = 0;
  let peakTimestamp = null;
  
  for (const point of dataPoints) {
    const value = parseFloat(point.value);
    if (value > peakValue) {
      peakValue = value;
      peakTimestamp = point.timestamp;
    }
  }
  
  if (peakTimestamp) {
    const date = new Date(peakTimestamp);
    const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${Math.round(peakValue)}W @ ${timeStr} (${dateStr})`;
  }
  
  return 'N/A';
}

/**
 * Fetch weather data from Open-Meteo API
 */
async function fetchWeatherData() {
  try {
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m,cloud_cover,shortwave_radiation&temperature_unit=fahrenheit&wind_speed_unit=mph`);
    const data = await response.json();
    
    if (data.current) {
      weatherData = {
        temperature: Math.round(data.current.temperature_2m),
        weatherCode: data.current.weather_code,
        humidity: data.current.relative_humidity_2m,
        windSpeed: Math.round(data.current.wind_speed_10m * 10) / 10,
        cloudCover: data.current.cloud_cover,
        solarRadiation: Math.round(data.current.shortwave_radiation),
        lastUpdate: new Date()
      };
      console.log(`🌤️ Weather updated: ${weatherData.temperature}°F, humidity: ${weatherData.humidity}%, wind: ${weatherData.windSpeed}mph, clouds: ${weatherData.cloudCover}%, solar: ${weatherData.solarRadiation}W/m²`);
    }
  } catch (error) {
    console.error('❌ Error fetching weather data:', error.message);
  }
}

/**
 * Get weather icon based on weather code
 */
function getWeatherIcon(weatherCode) {
  const iconMap = {
    0: '☀️', // Clear sky
    1: '🌤️', // Mainly clear
    2: '⛅', // Partly cloudy
    3: '☁️', // Overcast
    45: '🌫️', // Fog
    48: '🌫️', // Depositing rime fog
    51: '🌦️', // Light drizzle
    53: '🌦️', // Moderate drizzle
    55: '🌧️', // Dense drizzle
    61: '🌧️', // Slight rain
    63: '🌧️', // Moderate rain
    65: '🌧️', // Heavy rain
    71: '🌨️', // Slight snow
    73: '🌨️', // Moderate snow
    75: '🌨️', // Heavy snow
    77: '🌨️', // Snow grains
    80: '🌦️', // Slight rain showers
    81: '🌧️', // Moderate rain showers
    82: '🌧️', // Violent rain showers
    85: '🌨️', // Slight snow showers
    86: '🌨️', // Heavy snow showers
    95: '⛈️', // Thunderstorm
    96: '⛈️', // Thunderstorm with slight hail
    99: '⛈️'  // Thunderstorm with heavy hail
  };
  return iconMap[weatherCode] || '🌤️';
}

// Calculate seasonal peak sunlight hours based on date and location
function getSeasonalPeakHours() {
  const now = new Date();
  const month = now.getMonth();
  const solarNoon = 12;
  
  let peakDuration;
  if (month >= 5 && month <= 7) {
    peakDuration = 5; // Summer: 10 AM - 3 PM
  } else if (month >= 3 && month <= 4 || month >= 8 && month <= 9) {
    peakDuration = 4.5; // Spring/Fall: 9:45 AM - 2:15 PM
  } else {
    peakDuration = 4; // Winter: 10 AM - 2 PM
  }
  
  return {
    startHour: solarNoon - (peakDuration / 2),
    endHour: solarNoon + (peakDuration / 2),
    solarNoon: solarNoon,
    season: month >= 5 && month <= 7 ? 'Summer' : (month >= 3 && month <= 4 || month >= 8 && month <= 9 ? 'Spring/Fall' : 'Winter')
  };
}

// Check if current time is within peak sunlight hours
function isWithinPeakHours() {
  const now = new Date();
  const currentHour = now.getHours() + (now.getMinutes() / 60);
  const peakHours = getSeasonalPeakHours();
  return currentHour >= peakHours.startHour && currentHour <= peakHours.endHour;
}

// Format hour in 12-hour format with AM/PM
function formatHour(hour) {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const displayHour = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return displayHour + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
}

// ═══════════════════════════════════════════════════════════════════════════
// HISTORICAL DATA MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE: Store time-series data for charts (up to 365 days)
// STRUCTURE: { 'topic': [{timestamp: ISO8601, value: number}, ...] }
// PERSISTENCE: Saved to HISTORY_FILE every SAVE_INTERVAL (60 seconds)

/**
 * Load historical data from file
 * CALLED BY: Startup sequence (bottom of file)
 * IMPACT: Restores chart data from previous sessions
 * NOTE: Only loads data for topics in TRACKED_TOPICS array
 */
function loadHistoricalData() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf8');
      historicalData = JSON.parse(data);
      console.log(`📂 Loaded historical data from ${HISTORY_FILE}`);
      
      // Clean up old data
      pruneOldData();
    } else {
      // Initialize with empty arrays for tracked topics
      TRACKED_TOPICS.forEach(topic => {
        historicalData[topic] = [];
      });
      console.log('📂 No historical data file found, starting fresh');
    }
  } catch (error) {
    console.error('✗ Error loading historical data:', error.message);
    // Initialize with empty arrays
    TRACKED_TOPICS.forEach(topic => {
      historicalData[topic] = [];
    });
  }
}

/**
 * Save historical data to file
 * CALLED BY: setInterval (every 60 seconds)
 * IMPACT: Persists chart data across app restarts
 * WARNING: Can be slow with large datasets (consider async for production)
 */
function saveHistoricalData() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(historicalData, null, 2));
    console.log(`💾 Saved historical data (${Object.values(historicalData).reduce((sum, arr) => sum + arr.length, 0)} data points)`);
  } catch (error) {
    console.error('✗ Error saving historical data:', error.message);
  }
}

/**
 * Prune data older than DATA_RETENTION_DAYS
 */
function pruneOldData() {
  const cutoffTime = Date.now() - (DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let prunedCount = 0;
  
  for (const topic in historicalData) {
    const originalLength = historicalData[topic].length;
    historicalData[topic] = historicalData[topic].filter(entry => 
      new Date(entry.timestamp).getTime() > cutoffTime
    );
    prunedCount += originalLength - historicalData[topic].length;
  }
  
  if (prunedCount > 0) {
    console.log(`🧹 Pruned ${prunedCount} old data points (older than ${DATA_RETENTION_DAYS} days)`);
  }
}

/**
 * Add a data point to historical tracking (throttled to ARCHIVE_INTERVAL)
 */
function addHistoricalDataPoint(topic, value, timestamp) {
  if (TRACKED_TOPICS.includes(topic)) {
    const now = Date.now();
    const lastArchived = lastArchivedTime[topic] || 0;
    
    // Only archive if 60 seconds have passed since last archive for this topic
    if (now - lastArchived < ARCHIVE_INTERVAL) {
      return; // Skip archiving, but data is still in cachedData for real-time display
    }
    
    if (!historicalData[topic]) {
      historicalData[topic] = [];
    }
    
    // Only add if value is numeric
    const numValue = parseFloat(value);
    if (!isNaN(numValue)) {
      historicalData[topic].push({
        timestamp: timestamp,
        value: numValue
      });
      
      // Update last archived time
      lastArchivedTime[topic] = now;
      
      // Keep only last 10000 points per topic to prevent memory issues
      if (historicalData[topic].length > 10000) {
        historicalData[topic].shift();
      }
    }
  }
}

// Load historical data on startup
loadHistoricalData();

// Load daily stats on startup
loadDailyStats();

// Load alert settings on startup
loadAlertSettings();

// Fetch initial weather data
fetchWeatherData();

// Periodically save historical data and daily stats
setInterval(() => {
  pruneOldData();
  saveHistoricalData();
  saveDailyStats();
}, SAVE_INTERVAL);

// Periodically update weather data
setInterval(() => {
  fetchWeatherData();
}, WEATHER_UPDATE_INTERVAL);

// ═══════════════════════════════════════════════════════════════════════════
// DAILY SUMMARY SCHEDULING
// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE: Schedule daily summary emails at 8:00 PM

/**
 * Calculate milliseconds until next 8:00 PM
 */
function getMillisecondsUntilNext8PM() {
  const now = new Date();
  const tomorrow8PM = new Date(now);
  tomorrow8PM.setDate(tomorrow8PM.getDate() + 1);
  tomorrow8PM.setHours(20, 0, 0, 0); // 8:00 PM
  
  const today8PM = new Date(now);
  today8PM.setHours(20, 0, 0, 0); // 8:00 PM today
  
  // If it's before 8 PM today, schedule for today
  if (now < today8PM) {
    return today8PM.getTime() - now.getTime();
  } else {
    // Otherwise, schedule for tomorrow
    return tomorrow8PM.getTime() - now.getTime();
  }
}

/**
 * Schedule the next daily summary
 */
function scheduleNextDailySummary() {
  const msUntilNext = getMillisecondsUntilNext8PM();
  const nextSendTime = new Date(Date.now() + msUntilNext);
  
  console.log(`📅 Next daily summary scheduled for: ${nextSendTime.toLocaleString()}`);
  
  setTimeout(async () => {
    await sendDailySummaryReport();
    // Schedule the next one
    scheduleNextDailySummary();
  }, msUntilNext);
}

// Start the daily summary scheduling
scheduleNextDailySummary();

// ═══════════════════════════════════════════════════════════════════════════
// MQTT CLIENT - CORE DATA INGESTION
// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE: Subscribe to SolarAssistant MQTT broker for real-time data
// IMPACT: This is the PRIMARY DATA SOURCE for the entire application
// 
// DATA FLOW:
// 1. SolarAssistant publishes sensor data to MQTT broker
// 2. → client.on('message') receives updates
// 3. → cachedData[topic] stores latest value
// 4. → TRACKED_TOPICS are added to historicalData arrays
// 5. → Triggers charger control and alerts
// 6. → Dashboard polls /data endpoint for updates
//
// TOPICS: solar_assistant/# (wildcard subscribes to all SolarAssistant topics)
// Examples: solar_assistant/inverter_1/pv_power/state
//           solar_assistant/total/battery_state_of_charge/state
//           solar_assistant/battery_1/temperature/state

console.log(`🔌 Connecting to MQTT broker at ${MQTT_BROKER}...`);
console.log(`📡 Subscribing to topic: ${MQTT_TOPIC}\n`);

const client = mqtt.connect(MQTT_BROKER, {
  reconnectPeriod: 5000,    // Auto-reconnect every 5 seconds if disconnected
  connectTimeout: 10000,    // Wait 10 seconds before timing out
});

// MQTT connection events
client.on('connect', () => {
  connectionStatus = 'Connected';
  console.log('✓ Connected to MQTT broker');
  
  // Subscribe to all SolarAssistant topics
  client.subscribe(MQTT_TOPIC, (err) => {
    if (err) {
      console.error('✗ Failed to subscribe to topic:', err.message);
      connectionStatus = 'Subscription failed';
    } else {
      console.log(`✓ Subscribed to ${MQTT_TOPIC}`);
      console.log('📊 Waiting for messages...\n');
    }
  });
});

/**
 * MQTT Message Handler - PRIMARY DATA INGESTION POINT
 * CALLED BY: MQTT client when broker publishes to subscribed topics
 * IMPACT: Updates cachedData, historicalData, triggers alerts and charger control
 * FREQUENCY: Every time a sensor value changes (typically every 1-5 seconds)
 * 
 * CRITICAL FLOW:
 * 1. Parse incoming message (JSON or string)
 * 2. Update cachedData[topic] with latest value
 * 3. If topic is tracked → add to historicalData for charts
 * 4. If topic is battery SOC → trigger charger control
 * 5. Dashboard polls /data endpoint to get updated cachedData
 */
client.on('message', async (topic, message) => {
  try {
    messageCount++;
    const messageStr = message.toString();
    const timestamp = new Date().toISOString();
    
    // Try to parse as JSON, otherwise store as string
    let value;
    try {
      value = JSON.parse(messageStr);
    } catch (e) {
      value = messageStr;
    }
    
    // Store in cache using topic as key
    // IMPACT: This is what /data endpoint returns to dashboard
    cachedData[topic] = {
      value: value,
      timestamp: timestamp,
      raw: messageStr
    };
    
    // Add to historical data if it's a tracked topic
    addHistoricalDataPoint(topic, value, timestamp);
    
    // Update daily statistics
    updateDailyStats(topic, value);
    
    // Check for battery alerts and charger control
    if (topic === 'solar_assistant/total/battery_state_of_charge/state') {
      await checkBatteryAlerts(value);
      await controlBatteryCharger(value);
    }
    
    // Monitor peak discharge
    if (topic === 'solar_assistant/total/battery_power/state') {
      await monitorPeakDischarge(value);
    }
    
    lastUpdate = new Date();
    
    // Log message (limit console spam by only showing every 10th message details)
    if (messageCount % 10 === 1) {
      console.log(`✓ Message #${messageCount} - Topic: ${topic}`);
      console.log(`  Value: ${messageStr.substring(0, 100)}${messageStr.length > 100 ? '...' : ''}`);
    }
    
  } catch (error) {
    console.error(`✗ Error processing message from ${topic}:`, error.message);
  }
});

client.on('error', (error) => {
  connectionStatus = `Error: ${error.message}`;
  console.error('✗ MQTT connection error:', error.message);
});

client.on('offline', () => {
  connectionStatus = 'Offline - Reconnecting...';
  console.log('⚠ MQTT client offline, attempting to reconnect...');
});

client.on('reconnect', () => {
  connectionStatus = 'Reconnecting...';
  console.log('🔄 Reconnecting to MQTT broker...');
});

// ═══════════════════════════════════════════════════════════════════════════
// AUTHENTICATION MIDDLEWARE & ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE: JWT-based authentication to protect dashboard access
// SECURITY: All routes except /login and /api/auth/* require valid JWT

/**
 * Authentication Middleware (for API endpoints)
 * Verifies JWT token from cookie
 * Protects routes from unauthorized access
 */
function authenticateToken(req, res, next) {
  const token = req.cookies.token;
  
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  try {
    const user = jwt.verify(token, process.env.JWT_SECRET || 'default-secret-change-me');
    req.user = user;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Authentication Middleware (for HTML pages)
 * Redirects to /login if not authenticated
 */
function requireAuth(req, res, next) {
  const token = req.cookies.token;
  
  if (!token) {
    return res.redirect('/login');
  }
  
  try {
    const user = jwt.verify(token, process.env.JWT_SECRET || 'default-secret-change-me');
    req.user = user;
    next();
  } catch (error) {
    return res.redirect('/login');
  }
}

/**
 * POST /api/auth/login - User login
 * Validates credentials and issues JWT token
 */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    // Check credentials against environment variables
    const validUsername = process.env.ADMIN_USERNAME || 'admin';
    const validPasswordHash = process.env.ADMIN_PASSWORD_HASH;
    
    if (username !== validUsername) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Verify password
    const passwordMatch = await bcrypt.compare(password, validPasswordHash);
    
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Generate JWT token
    const token = jwt.sign(
      { username: username },
      process.env.JWT_SECRET || 'default-secret-change-me',
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    
    // Set HTTP-only cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: 'strict'
    });
    
    res.json({ 
      success: true, 
      message: 'Login successful',
      username: username
    });
    
    console.log(`✅ User logged in: ${username}`);
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/auth/logout - User logout
 * Clears JWT token cookie
 */
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'Logged out successfully' });
  console.log('✅ User logged out');
});

/**
 * GET /api/auth/check - Check authentication status
 * Returns current user info if authenticated
 */
app.get('/api/auth/check', authenticateToken, (req, res) => {
  res.json({ 
    authenticated: true, 
    username: req.user.username 
  });
});

/**
 * GET /api/version - Get application version
 * Public endpoint to check app version
 */
app.get('/api/version', (req, res) => {
  const pkg = require('./package.json');
  res.json({ 
    version: pkg.version,
    name: pkg.name,
    description: pkg.description
  });
});

/**
 * GET /settings - Settings page
 * Serves dedicated settings page (separate window)
 */
app.get('/settings-page', requireAuth, (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Settings - SolarAssistant Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    :root {
      --bg-gradient-start: #1a1a2e;
      --bg-gradient-end: #16213e;
      --card-bg: #1e1e2e;
      --text-primary: #f0f0f0;
      --text-secondary: #d0d0d0;
      --text-muted: #a0a0a0;
      --border-color: #404050;
      --success-color: #4ade80;
      --warning-color: #fbbf24;
      --danger-color: #f87171;
    }
    
    [data-theme="light"] {
      --bg-gradient-start: #f5f7fa;
      --bg-gradient-end: #c3cfe2;
      --card-bg: #ffffff;
      --text-primary: #2c3e50;
      --text-secondary: #34495e;
      --text-muted: #7f8c8d;
      --border-color: #dfe6e9;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, var(--bg-gradient-start) 0%, var(--bg-gradient-end) 100%);
      min-height: 100vh;
      padding: 20px;
      color: var(--text-primary);
    }
    
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    
    .header {
      background: var(--card-bg);
      padding: 20px 30px;
      border-radius: 12px;
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border: 1px solid var(--border-color);
    }
    
    h1 { color: var(--text-primary); font-size: 28px; }
    
    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      transition: all 0.3s ease;
    }
    
    .btn-primary {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(102, 126, 234, 0.4);
    }
    
    .btn-secondary {
      background: var(--border-color);
      color: var(--text-primary);
    }
    
    .accordion {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      margin-bottom: 15px;
      overflow: hidden;
    }
    
    .accordion-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 25px;
      cursor: pointer;
      transition: all 0.3s ease;
      border-bottom: 1px solid transparent;
    }
    
    .accordion-header:hover {
      background: rgba(102, 126, 234, 0.1);
    }
    
    .accordion-header.active {
      border-bottom-color: var(--border-color);
    }
    
    .accordion-header h3 {
      color: var(--text-primary);
      font-size: 18px;
      margin: 0;
    }
    
    .accordion-icon {
      font-size: 20px;
      transition: transform 0.3s ease;
      color: var(--text-secondary);
    }
    
    .accordion-header.active .accordion-icon {
      transform: rotate(180deg);
    }
    
    .accordion-content {
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.4s ease;
    }
    
    .accordion-content.active {
      max-height: 2000px;
      padding: 25px;
    }
    
    .form-group {
      margin-bottom: 20px;
    }
    
    .form-group label {
      display: block;
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--text-primary);
    }
    
    .form-group input[type="text"],
    .form-group input[type="email"],
    .form-group input[type="number"],
    .form-group input[type="time"],
    .form-group input[type="password"] {
      padding: 10px;
      border: 2px solid var(--border-color);
      border-radius: 8px;
      background: var(--card-bg);
      color: var(--text-primary);
      font-size: 14px;
    }
    
    .form-group small {
      display: block;
      margin-top: 5px;
      color: var(--text-muted);
      font-size: 12px;
    }
    
    .save-section {
      position: sticky;
      bottom: 0;
      background: var(--card-bg);
      padding: 20px;
      border-top: 2px solid var(--border-color);
      text-align: center;
      margin-top: 30px;
      border-radius: 0 0 12px 12px;
    }
    
    .btn-test {
      background: #3498db;
      color: white;
      padding: 8px 16px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
    }
    
    .info-box {
      background: #fff3cd;
      padding: 12px;
      border-radius: 6px;
      border-left: 3px solid #ffc107;
      margin-top: 15px;
      color: #856404;
      font-size: 12px;
    }
    
    .location-display {
      background: var(--card-bg);
      padding: 12px;
      border-radius: 6px;
      border: 1px solid var(--border-color);
      font-size: 13px;
      line-height: 1.8;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>⚙️ Settings</h1>
      <button onclick="window.location.href='/'" class="btn btn-secondary">← Back to Dashboard</button>
    </div>
    
    <div id="settings-container">
      <!-- Settings will be loaded here -->
      <p style="text-align: center; padding: 40px; color: var(--text-muted);">Loading settings...</p>
    </div>
    
    <div class="save-section">
      <button onclick="saveAllSettings()" class="btn btn-primary" style="padding: 15px 40px; font-size: 16px;">💾 Save All Settings</button>
      <p style="color: var(--text-muted); font-size: 12px; margin-top: 10px;">Saves all settings across all sections • Use "Back to Dashboard" to return</p>
    </div>
  </div>
  
  <script>
    // Load settings on page load
    document.addEventListener('DOMContentLoaded', loadAllSettings);
    
    function toggleAccordion(id) {
      const header = document.getElementById(id + '-header');
      const content = document.getElementById(id + '-content');
      
      if (header && content) {
        // Check if this accordion is already open
        const isCurrentlyOpen = header.classList.contains('active');
        
        if (isCurrentlyOpen) {
          // If it's open, just close it
          header.classList.remove('active');
          content.classList.remove('active');
        } else {
          // If it's closed, close all others first, then open this one
          const allHeaders = document.querySelectorAll('.accordion-header');
          const allContents = document.querySelectorAll('.accordion-content');
          
          allHeaders.forEach(h => h.classList.remove('active'));
          allContents.forEach(c => c.classList.remove('active'));
          
          // Then open the clicked one
          header.classList.add('active');
          content.classList.add('active');
        }
      }
    }
    
    function loadAllSettings() {
      console.log('Loading settings...');
      fetch('/settings/alerts', {
        credentials: 'same-origin'
      })
        .then(response => {
          console.log('Response status:', response.status);
          if (!response.ok) {
            throw new Error('Failed to load settings (status: ' + response.status + ')');
          }
          return response.json();
        })
        .then(data => {
          console.log('Settings data:', data);
          if (!data.settings) {
            throw new Error('Invalid settings data received');
          }
          renderSettings(data.settings, data.chargerState);
        })
        .catch(error => {
          console.error('Error loading settings:', error);
          document.getElementById('settings-container').innerHTML = '<p style="text-align: center; padding: 40px; color: red;">❌ Error loading settings: ' + error.message + '<br><br><a href="/">← Back to Dashboard</a></p>';
        });
    }
    
    function renderSettings(settings, chargerState) {
      try {
        const container = document.getElementById('settings-container');
        
        // Debug logging
        console.log('Rendering settings:', settings);
        
        let html = '';
      
      // System Configuration Accordion
      html += '<div class="accordion">';
      html += '  <div class="accordion-header" id="system-header" onclick="toggleAccordion(' + "'" + 'system' + "'" + ')">';
      html += '    <h3>⚙️ System Configuration</h3>';
      html += '    <span class="accordion-icon">▼</span>';
      html += '  </div>';
      html += '  <div class="accordion-content" id="system-content">';
      html += '    <div class="form-group">';
      html += '      <label for="mqttBroker">MQTT Broker Address:</label>';
      html += '      <input type="text" id="mqttBroker" value="' + (settings.systemSettings?.mqttBroker || 'mqtt://192.168.1.228:1883') + '" style="width: 100%;">';
      html += '      <small>MQTT broker URL (requires app restart)</small>';
      html += '    </div>';
      html += '    <div class="form-group">';
      html += '      <label for="mqttTopic">MQTT Topic:</label>';
      html += '      <input type="text" id="mqttTopic" value="' + (settings.systemSettings?.mqttTopic || 'solar_assistant/#') + '" style="width: 100%;">';
      html += '      <small>Subscribe pattern (# = all topics)</small>';
      html += '    </div>';
      html += '    <div class="form-group">';
      html += '      <label for="zipCode">Zip Code:</label>';
      html += '      <input type="text" id="zipCode" value="' + (settings.systemSettings?.zipCode || '85142') + '" style="width: 150px;">';
      html += '      <button onclick="lookupZipCode()" class="btn-test" style="margin-left: 10px;">📍 Lookup</button>';
      html += '      <small>Auto-convert to lat/long for weather</small>';
      html += '    </div>';
      html += '    <div class="form-group">';
      html += '      <label>Location Details:</label>';
      html += '      <div class="location-display">';
      html += '        <div><strong>Name:</strong> <span id="locationNameDisplay">' + (settings.systemSettings?.locationName || 'Queen Creek, AZ') + '</span></div>';
      html += '        <div><strong>Latitude:</strong> <span id="latitudeDisplay">' + (settings.systemSettings?.latitude || '33.2487') + '</span></div>';
      html += '        <div><strong>Longitude:</strong> <span id="longitudeDisplay">' + (settings.systemSettings?.longitude || '-111.6343') + '</span></div>';
      html += '        <div><strong>Timezone:</strong> <span id="timezoneDisplay">' + (settings.systemSettings?.timezone || 'America/Phoenix') + '</span></div>';
      html += '      </div>';
      html += '      <input type="hidden" id="latitude" value="' + (settings.systemSettings?.latitude || '33.2487') + '">';
      html += '      <input type="hidden" id="longitude" value="' + (settings.systemSettings?.longitude || '-111.6343') + '">';
      html += '      <input type="hidden" id="locationName" value="' + (settings.systemSettings?.locationName || 'Queen Creek, AZ') + '">';
      html += '      <input type="hidden" id="timezone" value="' + (settings.systemSettings?.timezone || 'America/Phoenix') + '">';
      html += '    </div>';
      html += '    <div class="info-box">';
      html += '      <strong>⚠️ Note:</strong> MQTT changes require app restart. Location changes take effect immediately.';
      html += '    </div>';
      html += '  </div>';
      html += '</div>';
      
      // Email Alert Settings Accordion
      html += '<div class="accordion" style="margin-top: 20px;">';
      html += '  <div class="accordion-header" id="email-header" onclick="toggleAccordion(' + "'" + 'email' + "'" + ')">';
      html += '    <h3>📧 Email Alert Settings</h3>';
      html += '    <span class="accordion-icon">▼</span>';
      html += '  </div>';
      html += '  <div class="accordion-content" id="email-content">';
      html += '    <div class="form-group">';
      html += '      <label><input type="checkbox" id="emailEnabled" ' + (settings.enabled ? 'checked' : '') + '> Enable Email Alerts</label>';
      html += '    </div>';
      html += '    <div class="form-group">';
      html += '      <label for="fromEmail">From Email Address:</label>';
      html += '      <input type="email" id="fromEmail" value="' + (settings.fromEmail || 'notify@wpsitemail.com') + '" style="width: 100%;">';
      html += '      <small>Email address that sends alerts (must be verified in SendGrid)</small>';
      html += '    </div>';
      html += '    <div class="form-group">';
      html += '      <label for="toEmail">To Email Address:</label>';
      html += '      <input type="email" id="toEmail" value="' + (settings.toEmail || '') + '" style="width: 100%;">';
      html += '      <small>Email address that receives alerts</small>';
      html += '    </div>';
      html += '    <div class="form-group">';
      html += '      <label for="sendgridApiKey">SendGrid API Key:</label>';
      html += '      <input type="password" id="sendgridApiKey" placeholder="Enter new API key" style="width: 100%;">';
      html += '      <small>' + (settings.sendgridApiKey ? 'Current: ' + settings.sendgridApiKey + ' • Leave blank to keep existing' : 'Enter your SendGrid API key') + '</small>';
      html += '    </div>';
      html += '    <div class="form-group">';
      html += '      <label for="lowThreshold">Low Battery Threshold (%):</label>';
      html += '      <input type="number" id="lowThreshold" value="' + (settings.lowThreshold || 50) + '" min="0" max="100" style="width: 100px;">';
      html += '    </div>';
      html += '    <div class="form-group">';
      html += '      <label for="highThreshold">Recovery Threshold (%):</label>';
      html += '      <input type="number" id="highThreshold" value="' + (settings.highThreshold || 85) + '" min="0" max="100" style="width: 100px;">';
      html += '    </div>';
      html += '    <div class="form-group">';
      html += '      <label>Test Email Functionality:</label>';
      html += '      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px;">';
      html += '        <button onclick="testEmail()" class="btn-test" style="background: #3498db; padding: 12px;">📧 Test Email</button>';
      html += '        <button onclick="testDailySummary()" class="btn-test" style="background: #9b59b6; padding: 12px;">📊 Test Daily Report</button>';
      html += '      </div>';
      html += '      <small style="display: block; margin-top: 8px;">Test email delivery and daily summary functionality</small>';
      html += '    </div>';
      html += '  </div>';
      html += '</div>';
      
      // Battery Charger Control Accordion
      html += '<div class="accordion" style="margin-top: 20px;">';
      html += '  <div class="accordion-header" id="charger-header" onclick="toggleAccordion(' + "'" + 'charger' + "'" + ')">';
      html += '    <h3>🔌 Battery Charger Control</h3>';
      html += '    <span class="accordion-icon">▼</span>';
      html += '  </div>';
      html += '  <div class="accordion-content" id="charger-content">';
      html += '    <div class="form-group">';
      html += '      <label><input type="checkbox" id="chargerEnabled" ' + (settings.chargerControl?.enabled ? 'checked' : '') + '> Enable Automatic Charger Control</label>';
      html += '    </div>';
      html += '    <div class="form-group">';
      html += '      <label for="iftttWebhookKey">IFTTT Webhook Key:</label>';
      html += '      <input type="password" id="iftttWebhookKey" placeholder="Enter new webhook key" style="width: 100%;">';
      html += '      <small>' + (settings.chargerControl?.iftttWebhookKey ? 'Current: ' + settings.chargerControl.iftttWebhookKey + ' • Leave blank to keep existing' : 'Enter your IFTTT webhook key') + '</small>';
      html += '    </div>';
      html += '    <div class="form-group">';
      html += '      <label for="chargerLowThreshold">Turn ON at (%):</label>';
      html += '      <input type="number" id="chargerLowThreshold" value="' + (settings.chargerControl?.lowThreshold || 50) + '" min="0" max="100" style="width: 100px;">';
      html += '    </div>';
      html += '    <div class="form-group">';
      html += '      <label for="chargerHighThreshold">Turn OFF at (%):</label>';
      html += '      <input type="number" id="chargerHighThreshold" value="' + (settings.chargerControl?.highThreshold || 90) + '" min="0" max="100" style="width: 100px;">';
      html += '    </div>';
      html += '    <div class="form-group">';
      html += '      <label for="chargerPlugName">Smart Plug Name:</label>';
      html += '      <input type="text" id="chargerPlugName" value="' + (settings.chargerControl?.plugName || 'Battery Charger') + '" style="width: 100%;">';
      html += '    </div>';
      html += '    <div class="form-group">';
      html += '      <label for="chargerMaxTemp">Max Temperature (°C):</label>';
      html += '      <input type="number" id="chargerMaxTemp" value="' + (settings.chargerControl?.maxTemp || 45) + '" min="0" max="100" style="width: 100px;">';
      html += '      <small>Auto-shutoff temperature</small>';
      html += '    </div>';
      html += '  </div>';
      html += '</div>';
      
      // Peak Discharge Monitoring Accordion
      html += '<div class="accordion" style="margin-top: 20px;">';
      html += '  <div class="accordion-header" id="peak-header" onclick="toggleAccordion(' + "'" + 'peak' + "'" + ')">';
      html += '    <h3>☀️ Peak Discharge Monitoring</h3>';
      html += '    <span class="accordion-icon">▼</span>';
      html += '  </div>';
      html += '  <div class="accordion-content" id="peak-content">';
      html += '    <div class="form-group">';
      html += '      <label><input type="checkbox" id="peakDischargeEnabled" ' + (settings.peakDischargeAlert?.enabled ? 'checked' : '') + '> Enable Peak Discharge Alerts</label>';
      html += '      <small style="display: block; margin-top: 5px;">Get notified when battery discharges during peak sunlight hours</small>';
      html += '    </div>';
      html += '    <div class="form-group">';
      html += '      <label for="peakDischargeDuration">Alert After (minutes):</label>';
      html += '      <input type="number" id="peakDischargeDuration" value="' + (settings.peakDischargeAlert?.durationMinutes || 30) + '" min="5" max="120" style="width: 100px;">';
      html += '    </div>';
      html += '    <div class="info-box">';
      html += '      <strong>📅 Seasonal Peak Hours:</strong><br>';
      html += '      <div style="margin-top: 8px; line-height: 1.6;">';
      html += '        <strong>Summer (Jun-Aug):</strong> 10:00 AM - 3:00 PM<br>';
      html += '        <strong>Spring/Fall (Mar-May, Sep-Oct):</strong> 9:45 AM - 2:15 PM<br>';
      html += '        <strong>Winter (Nov-Feb):</strong> 10:00 AM - 2:00 PM';
      html += '      </div>';
      html += '    </div>';
      html += '  </div>';
      html += '</div>';
      
      // Manual Charger Control Accordion
      html += '<div class="accordion" style="margin-top: 20px;">';
      html += '  <div class="accordion-header" id="manual-header" onclick="toggleAccordion(' + "'" + 'manual' + "'" + ')">';
      html += '    <h3>🔧 Manual Charger Control</h3>';
      html += '    <span class="accordion-icon">▼</span>';
      html += '  </div>';
      html += '  <div class="accordion-content" id="manual-content">';
      html += '    <div class="form-group">';
      html += '      <label>Manual Charger Control:</label>';
      html += '      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px;">';
      html += '        <button onclick="testChargerControl(' + "'" + 'on' + "'" + ')" class="btn-test" style="background: #27ae60; padding: 12px;">🔌 Turn ON</button>';
      html += '        <button onclick="testChargerControl(' + "'" + 'off' + "'" + ')" class="btn-test" style="background: #e74c3c; padding: 12px;">🔌 Turn OFF</button>';
      html += '      </div>';
      html += '      <small style="display: block; margin-top: 8px;">Override all settings and thresholds • Check your smart plug for confirmation</small>';
      html += '    </div>';
      html += '    <div class="info-box">';
      html += '      <strong>⚠️ Manual Override:</strong> These buttons bypass ALL automatic controls, thresholds, and cooldowns.';
      html += '    </div>';
      html += '  </div>';
      html += '</div>';
      
      // Daily Email Reports Accordion
      html += '<div class="accordion" style="margin-top: 20px;">';
      html += '  <div class="accordion-header" id="daily-header" onclick="toggleAccordion(' + "'" + 'daily' + "'" + ')">';
      html += '    <h3>📊 Daily Email Reports</h3>';
      html += '    <span class="accordion-icon">▼</span>';
      html += '  </div>';
      html += '  <div class="accordion-content" id="daily-content">';
      html += '    <div class="form-group">';
      html += '      <label><input type="checkbox" id="dailySummaryEnabled" ' + (settings.dailySummary?.enabled ? 'checked' : '') + '> Enable Daily Email Reports</label>';
      html += '      <small style="display: block; margin-top: 5px;">Receive daily summary reports via email</small>';
      html += '    </div>';
      html += '    <div class="form-group">';
      html += '      <label for="dailySummaryTime">Report Time:</label>';
      html += '      <input type="time" id="dailySummaryTime" value="' + (settings.dailySummary?.sendTime || '20:00') + '" style="width: 150px;">';
      html += '      <small>Time to send daily reports (24-hour format)</small>';
      html += '    </div>';
      html += '    <div class="info-box">';
      html += '      <strong>Daily Reports Include:</strong><br>';
      html += '      Energy production and consumption summary<br>';
      html += '      Battery performance and charging cycles<br>';
      html += '      Weather conditions and impact<br>';
      html += '      System alerts and notifications';
      html += '    </div>';
      html += '  </div>';
      html += '</div>';
      
        container.innerHTML = html;
      } catch (error) {
        console.error('Error in renderSettings:', error);
        container.innerHTML = '<p style="text-align: center; padding: 40px; color: red;">ERROR: Error rendering settings: ' + error.message + '<br><br><a href="/">Back to Dashboard</a></p>';
      }
    }
    
    function testChargerControl(action) {
      fetch('/settings/charger/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action })
      })
        .then(response => response.json())
        .then(data => {
          if (data.success) {
            const state = data.chargerState;
            let message = 'SUCCESS: ' + data.message + '\\n\\n';
            message += 'Charger State:\\n';
            message += 'Status: ' + (state.isOn ? 'ON' : 'OFF') + '\\n';
            message += 'Last Action: ' + (state.lastAction || 'None') + '\\n';
            message += 'Time: ' + (state.lastActionTime ? new Date(state.lastActionTime).toLocaleString() : 'N/A') + '\\n\\n';
            message += 'Check your smart plug for confirmation.';
            alert(message);
          } else {
            alert('ERROR: ' + (data.message || data.error));
          }
        })
        .catch(error => {
          alert('ERROR: ' + error.message);
        });
    }
    
    function testEmail() {
      fetch('/settings/alerts/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
        .then(response => response.json())
        .then(data => {
          if (data.success) {
            alert('SUCCESS: Test email sent successfully! Check your inbox.');
          } else {
            alert('ERROR: ' + (data.message || data.error));
          }
        })
        .catch(error => {
          alert('ERROR: ' + error.message);
        });
    }
    
    function testDailySummary() {
      fetch('/settings/daily-summary/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
        .then(response => response.json())
        .then(data => {
          if (data.success) {
            alert('SUCCESS: Test daily summary sent successfully! Check your email.');
          } else {
            alert('ERROR: ' + (data.message || data.error));
          }
        })
        .catch(error => {
          alert('ERROR: ' + error.message);
        });
    }
    
    function lookupZipCode() {
      const zipCode = document.getElementById('zipCode').value;
      if (!zipCode) {
        alert('Please enter a zip code');
        return;
      }
      
      fetch('https://nominatim.openstreetmap.org/search?postalcode=' + zipCode + '&country=US&format=json&limit=1')
        .then(response => response.json())
        .then(data => {
          if (data && data.length > 0) {
            const loc = data[0];
            document.getElementById('latitude').value = loc.lat;
            document.getElementById('longitude').value = loc.lon;
            document.getElementById('locationName').value = loc.display_name;
            document.getElementById('latitudeDisplay').textContent = parseFloat(loc.lat).toFixed(4);
            document.getElementById('longitudeDisplay').textContent = parseFloat(loc.lon).toFixed(4);
            document.getElementById('locationNameDisplay').textContent = loc.display_name;
            alert('✅ Location found: ' + loc.display_name);
          } else {
            alert('❌ Zip code not found');
          }
        })
        .catch(error => alert('❌ Error: ' + error.message));
    }
    
    function saveAllSettings() {
      const settings = {
        enabled: document.getElementById('emailEnabled').checked,
        fromEmail: document.getElementById('fromEmail').value,
        toEmail: document.getElementById('toEmail').value,
        lowThreshold: parseInt(document.getElementById('lowThreshold').value),
        highThreshold: parseInt(document.getElementById('highThreshold').value),
        sendgridApiKey: document.getElementById('sendgridApiKey').value || undefined,
        systemSettings: {
          mqttBroker: document.getElementById('mqttBroker').value,
          mqttTopic: document.getElementById('mqttTopic').value,
          zipCode: document.getElementById('zipCode').value,
          latitude: parseFloat(document.getElementById('latitude').value),
          longitude: parseFloat(document.getElementById('longitude').value),
          locationName: document.getElementById('locationName').value,
          timezone: document.getElementById('timezone').value
        },
        chargerControl: {
          enabled: document.getElementById('chargerEnabled').checked,
          iftttWebhookKey: document.getElementById('iftttWebhookKey').value || undefined,
          lowThreshold: parseInt(document.getElementById('chargerLowThreshold').value),
          highThreshold: parseInt(document.getElementById('chargerHighThreshold').value),
          plugName: document.getElementById('chargerPlugName').value,
          maxTemp: parseInt(document.getElementById('chargerMaxTemp').value)
        },
        peakDischargeAlert: {
          enabled: document.getElementById('peakDischargeEnabled').checked,
          durationMinutes: parseInt(document.getElementById('peakDischargeDuration').value)
        },
        dailySummary: {
          enabled: document.getElementById('dailySummaryEnabled').checked,
          sendTime: document.getElementById('dailySummaryTime').value,
          timezone: 'America/Phoenix'
        }
      };
      
      fetch('/settings/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      })
        .then(response => response.json())
        .then(data => {
          if (data.success) {
            alert('✅ Settings saved successfully!');
            // Stay on settings page for additional changes
          } else {
            alert('❌ Error: ' + (data.error || 'Unknown error'));
          }
        })
        .catch(error => alert('❌ Error: ' + error.message));
    }
  </script>
</body>
</html>
  `);
});

// ═══════════════════════════════════════════════════════════════════════════
// BATTERY DETAILS PAGE
// ═══════════════════════════════════════════════════════════════════════════
app.get('/battery', requireAuth, (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Battery Details - SolarAssistant Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    :root {
      --bg-gradient-start: #1a1a2e;
      --bg-gradient-end: #16213e;
      --card-bg: #1e1e2e;
      --text-primary: #f0f0f0;
      --text-secondary: #d0d0d0;
      --text-muted: #a0a0a0;
      --border-color: #404050;
      --success-color: #27ae60;
      --warning-color: #f39c12;
      --danger-color: #e74c3c;
      --info-color: #3498db;
      --accent-color: #667eea;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, var(--bg-gradient-start) 0%, var(--bg-gradient-end) 100%);
      min-height: 100vh;
      padding: 20px;
      color: var(--text-primary);
    }
    
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    
    .header {
      background: var(--card-bg);
      padding: 20px 30px;
      border-radius: 12px;
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border: 1px solid var(--border-color);
    }
    
    h1 {
      color: var(--text-primary);
      font-size: 28px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    
    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      transition: all 0.3s ease;
    }
    
    .btn-secondary {
      background: var(--border-color);
      color: var(--text-primary);
    }
    
    .btn-secondary:hover {
      background: var(--accent-color);
      color: white;
    }
    
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }
    
    #overview-cards {
      grid-template-columns: repeat(5, 1fr);
    }
    
    @media (max-width: 1200px) {
      #overview-cards {
        grid-template-columns: repeat(3, 1fr);
      }
    }
    
    @media (max-width: 768px) {
      #overview-cards {
        grid-template-columns: 1fr;
      }
    }
    
    .card {
      background: var(--card-bg);
      border-radius: 12px;
      padding: 20px;
      border: 1px solid var(--border-color);
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    
    .card h3 {
      font-size: 16px;
      color: var(--text-secondary);
      margin-bottom: 15px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .stat-value {
      font-size: 32px;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 5px;
    }
    
    .stat-label {
      font-size: 12px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 15px;
      margin-top: 15px;
    }
    
    .stat-item {
      text-align: center;
      padding: 10px;
      background: rgba(255, 255, 255, 0.02);
      border-radius: 8px;
      border: 1px solid var(--border-color);
    }
    
    .stat-item-value {
      font-size: 20px;
      font-weight: 600;
      color: var(--text-primary);
    }
    
    .stat-item-label {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 5px;
    }
    
    .battery-comparison {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 15px;
      margin-bottom: 20px;
    }
    
    .battery-card {
      background: var(--card-bg);
      border-radius: 12px;
      padding: 20px;
      border: 2px solid var(--border-color);
      position: relative;
    }
    
    .battery-card h4 {
      font-size: 18px;
      margin-bottom: 15px;
      color: var(--success-color);
    }
    
    .health-badge {
      position: absolute;
      top: 15px;
      right: 15px;
      background: var(--success-color);
      color: white;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }
    
    .chart-container {
      background: var(--card-bg);
      border-radius: 12px;
      padding: 20px;
      border: 1px solid var(--border-color);
      margin-bottom: 20px;
    }
    
    .chart-container h3 {
      font-size: 18px;
      margin-bottom: 15px;
      color: var(--text-primary);
    }
    
    canvas {
      max-height: 300px;
    }
    
    .loading {
      text-align: center;
      padding: 40px;
      color: var(--text-muted);
      font-size: 16px;
    }
    
    .error {
      background: rgba(231, 76, 60, 0.1);
      border: 1px solid var(--danger-color);
      color: var(--danger-color);
      padding: 15px;
      border-radius: 8px;
      text-align: center;
    }
    
    
    .chart-selector-label {
      font-size: 14px;
      color: var(--text-secondary);
      font-weight: 500;
    }
    
    .chart-selector {
      padding: 6px 12px;
      border: 2px solid var(--border-color);
      border-radius: 8px;
      background: var(--card-bg);
      font-size: 14px;
      color: var(--text-primary);
      cursor: pointer;
      transition: all 0.3s ease;
    }
    
    .chart-selector:hover {
      border-color: var(--accent-color);
    }
    
    .chart-selector:focus {
      outline: none;
      border-color: var(--accent-color);
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }
    
    @media (max-width: 768px) {
      .battery-comparison {
        grid-template-columns: 1fr;
      }
      
      h1 {
        font-size: 22px;
      }
      
      .grid {
        grid-template-columns: 1fr;
      }
      
      .chart-container > div:first-child {
        flex-direction: column;
        gap: 10px;
        align-items: flex-start !important;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🔋 Battery Details</h1>
      <button onclick="window.location.href='/'" class="btn btn-secondary">← Back to Dashboard</button>
    </div>
    
    <div id="battery-content" class="loading">Loading battery data...</div>
  </div>
  
  <script>
    let batteryData = null;
    let charts = {};
    
    // Load battery data on page load
    document.addEventListener('DOMContentLoaded', loadBatteryData);
    
    async function loadBatteryData() {
      try {
        const response = await fetch('/data/battery', {
          credentials: 'same-origin'
        });
        
        if (!response.ok) {
          throw new Error('Failed to load battery data');
        }
        
        batteryData = await response.json();
        renderBatteryPage();
        
        // Refresh every 5 seconds
        setInterval(refreshBatteryData, 5000);
      } catch (error) {
        console.error('Error loading battery data:', error);
        document.getElementById('battery-content').innerHTML = 
          '<div class="error">Error loading battery data: ' + error.message + '</div>';
      }
    }
    
    async function refreshBatteryData() {
      try {
        const response = await fetch('/data/battery', {
          credentials: 'same-origin'
        });
        
        if (response.ok) {
          batteryData = await response.json();
          updateBatteryValues();
        }
      } catch (error) {
        console.error('Error refreshing data:', error);
      }
    }
    
    function renderBatteryPage() {
      const container = document.getElementById('battery-content');
      
      let html = '';
      
      // Overview Cards
      html += '<div class="grid" id="overview-cards">';
      html += '<div class="card"><h3 style="color: #27ae60">State of Charge</h3><div class="stat-value" id="total-soc">Loading...</div></div>';
      html += '<div class="card"><h3 style="color: #3498db">Total Power</h3><div class="stat-value" id="total-power">Loading...</div></div>';
      html += '<div class="card"><h3 style="color: #667eea">Voltage</h3><div class="stat-value" id="total-voltage">Loading...</div></div>';
      html += '<div class="card"><h3 style="color: #f39c12">Temperature</h3><div class="stat-value" id="total-temperature">Loading...</div></div>';
      html += '<div class="card"><h3 style="color: #9b59b6">Total Current</h3><div class="stat-value" id="total-current">Loading...</div></div>';
      html += '</div>';
      
      // Individual Battery Comparison
      html += '<div class="battery-comparison" id="battery-cards">';
      html += '<div class="loading">Loading battery data...</div>';
      html += '</div>';
      
      // Charts
      html += '<div class="chart-container">';
      html += '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">';
      html += '<h3 style="margin: 0;">Battery Power Flow (Past Hour)</h3>';
      html += '<div style="display: flex; align-items: center; gap: 10px;">';
      html += '<label for="powerSelector" class="chart-selector-label">View:</label>';
      html += '<select id="powerSelector" onchange="changeBatteryView(' + "'power'" + ', this.value)" class="chart-selector">';
      html += '<option value="all">All Batteries</option>';
      html += '<option value="battery1">Battery 1 Only</option>';
      html += '<option value="battery2">Battery 2 Only</option>';
      html += '<option value="battery3">Battery 3 Only</option>';
      html += '</select>';
      html += '</div>';
      html += '</div>';
      html += '<canvas id="powerChart"></canvas>';
      html += '</div>';
      
      html += '<div class="chart-container">';
      html += '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">';
      html += '<h3 style="margin: 0;">Battery Temperatures (Past Hour)</h3>';
      html += '<div style="display: flex; align-items: center; gap: 10px;">';
      html += '<label for="tempSelector" class="chart-selector-label">View:</label>';
      html += '<select id="tempSelector" onchange="changeBatteryView(' + "'temp'" + ', this.value)" class="chart-selector">';
      html += '<option value="all">All Batteries</option>';
      html += '<option value="battery1">Battery 1 Only</option>';
      html += '<option value="battery2">Battery 2 Only</option>';
      html += '<option value="battery3">Battery 3 Only</option>';
      html += '</select>';
      html += '</div>';
      html += '</div>';
      html += '<canvas id="tempChart"></canvas>';
      html += '</div>';
      
      html += '<div class="chart-container">';
      html += '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">';
      html += '<h3 style="margin: 0;">Individual Battery Voltages (Past Hour)</h3>';
      html += '<div style="display: flex; align-items: center; gap: 10px;">';
      html += '<label for="voltageSelector" class="chart-selector-label">View:</label>';
      html += '<select id="voltageSelector" onchange="changeBatteryView(' + "'voltage'" + ', this.value)" class="chart-selector">';
      html += '<option value="all">All Batteries</option>';
      html += '<option value="battery1">Battery 1 Only</option>';
      html += '<option value="battery2">Battery 2 Only</option>';
      html += '<option value="battery3">Battery 3 Only</option>';
      html += '</select>';
      html += '</div>';
      html += '</div>';
      html += '<canvas id="voltageChart"></canvas>';
      html += '</div>';
      
      html += '<div class="chart-container">';
      html += '<h3>Cell Voltage Balance</h3>';
      html += '<canvas id="cellBalanceChart"></canvas>';
      html += '</div>';
      
      container.innerHTML = html;
      
      // Create charts
      createCharts();
      
      // Update overview cards and battery cards with actual data
      updateOverviewCards();
      updateBatteryCards();
    }
    
    function updateOverviewCards() {
      if (!batteryData) return;
      
      document.getElementById('total-soc').textContent = (batteryData.total.soc || 0) + '%';
      document.getElementById('total-power').textContent = formatPower(batteryData.total.power);
      document.getElementById('total-voltage').textContent = (batteryData.total.voltage || 0).toFixed(1) + 'V';
      document.getElementById('total-temperature').textContent = (batteryData.total.temperature || 0).toFixed(1) + '°F';
      document.getElementById('total-current').textContent = (batteryData.total.current || 0).toFixed(1) + 'A';
    }
    
    function updateBatteryCards() {
      if (!batteryData) return;
      
      const container = document.getElementById('battery-cards');
      let html = '';
      
      batteryData.batteries.forEach(battery => {
        html += renderBatteryCard(battery);
      });
      
      container.innerHTML = html;
    }
    
    function renderOverviewCard(label, value, color) {
      const colors = {
        success: '#27ae60',
        warning: '#f39c12',
        danger: '#e74c3c',
        info: '#3498db',
        accent: '#667eea'
      };
      
      return '<div class="card">' +
        '<h3 style="color: ' + (colors[color] || colors.accent) + '">' + label + '</h3>' +
        '<div class="stat-value">' + value + '</div>' +
        '</div>';
    }
    
    function renderBatteryCard(battery) {
      const cellDiff = (battery.cellVoltage.highest - battery.cellVoltage.lowest).toFixed(3);
      
      return '<div class="battery-card">' +
        '<div class="health-badge">' + (battery.soh || 100) + '% Health</div>' +
        '<h4>Battery ' + battery.id + '</h4>' +
        '<div class="stat-grid">' +
          '<div class="stat-item">' +
            '<div class="stat-item-value">' + (battery.voltage || 0).toFixed(1) + 'V</div>' +
            '<div class="stat-item-label">Voltage</div>' +
          '</div>' +
          '<div class="stat-item">' +
            '<div class="stat-item-value">' + (battery.current || 0).toFixed(1) + 'A</div>' +
            '<div class="stat-item-label">Current</div>' +
          '</div>' +
          '<div class="stat-item">' +
            '<div class="stat-item-value">' + formatPower(battery.power) + '</div>' +
            '<div class="stat-item-label">Power</div>' +
          '</div>' +
          '<div class="stat-item">' +
            '<div class="stat-item-value">' + (battery.temperature || 0).toFixed(1) + '°F</div>' +
            '<div class="stat-item-label">Temperature</div>' +
          '</div>' +
          '<div class="stat-item">' +
            '<div class="stat-item-value">' + (battery.soc || 0) + '%</div>' +
            '<div class="stat-item-label">SOC</div>' +
          '</div>' +
          '<div class="stat-item">' +
            '<div class="stat-item-value">' + (battery.cellVoltage.average || 0).toFixed(3) + 'V</div>' +
            '<div class="stat-item-label">Avg Cell</div>' +
          '</div>' +
          '<div class="stat-item">' +
            '<div class="stat-item-value">' + (battery.cellVoltage.highest || 0).toFixed(3) + 'V</div>' +
            '<div class="stat-item-label">Max Cell</div>' +
          '</div>' +
          '<div class="stat-item">' +
            '<div class="stat-item-value">' + cellDiff + 'V</div>' +
            '<div class="stat-item-label">Difference</div>' +
          '</div>' +
        '</div>' +
        '</div>';
    }
    
    function formatPower(power) {
      if (!power) return '0W';
      const abs = Math.abs(power);
      if (abs >= 1000) {
        return (power / 1000).toFixed(2) + 'kW';
      }
      return Math.round(power) + 'W';
    }
    
    function createCharts() {
      // Debug: Check if we have historical data
      console.log('Creating charts...');
      console.log('Power history battery_1:', batteryData.history.power.battery_1?.length || 0, 'points');
      console.log('Power history battery_2:', batteryData.history.power.battery_2?.length || 0, 'points');
      console.log('Power history battery_3:', batteryData.history.power.battery_3?.length || 0, 'points');
      console.log('Temp history battery_1:', batteryData.history.temperature.battery_1?.length || 0, 'points');
      console.log('Voltage history battery_1:', batteryData.history.voltage.battery_1?.length || 0, 'points');
      
      // Debug: Show sample data
      if (batteryData.history.power.battery_1 && batteryData.history.power.battery_1.length > 0) {
        console.log('Sample battery 1 power data:', JSON.stringify(batteryData.history.power.battery_1[0], null, 2));
      }
      
      // Debug: Check filtered data
      const filteredPower1 = filterLastHour(batteryData.history.power.battery_1);
      console.log('Filtered power 1 data:', filteredPower1?.length || 0, 'points');
      if (filteredPower1 && filteredPower1.length > 0) {
        console.log('Sample filtered data:', JSON.stringify(filteredPower1[0], null, 2));
      }
      
      // Power Flow Chart (Line Chart)
      const powerCtx = document.getElementById('powerChart').getContext('2d');
      charts.power = new Chart(powerCtx, {
        type: 'line',
        data: {
          datasets: [
            {
              label: 'Battery 1',
              data: filterLastHour(batteryData.history.power.battery_1).map(point => ({
                timestamp: new Date(point.timestamp),
                value: point.value
              })),
              backgroundColor: 'rgba(39, 174, 96, 0.1)',
              borderColor: '#27ae60',
              borderWidth: 2,
              tension: 0.4,
              fill: true
            },
            {
              label: 'Battery 2',
              data: filterLastHour(batteryData.history.power.battery_2).map(point => ({
                timestamp: new Date(point.timestamp),
                value: point.value
              })),
              backgroundColor: 'rgba(52, 152, 219, 0.1)',
              borderColor: '#3498db',
              borderWidth: 2,
              tension: 0.4,
              fill: true
            },
            {
              label: 'Battery 3',
              data: filterLastHour(batteryData.history.power.battery_3).map(point => ({
                timestamp: new Date(point.timestamp),
                value: point.value
              })),
              backgroundColor: 'rgba(243, 156, 18, 0.1)',
              borderColor: '#f39c12',
              borderWidth: 2,
              tension: 0.4,
              fill: true
            }
          ]
        },
        options: getChartOptions('Power (W)')
      });
      
      // Temperature Chart (Line Chart)
      const tempCtx = document.getElementById('tempChart').getContext('2d');
      charts.temp = new Chart(tempCtx, {
        type: 'line',
        data: {
          datasets: [
            {
              label: 'Battery 1',
              data: filterLastHour(batteryData.history.temperature.battery_1).map(point => ({
                timestamp: new Date(point.timestamp),
                value: point.value
              })),
              backgroundColor: 'rgba(39, 174, 96, 0.1)',
              borderColor: '#27ae60',
              borderWidth: 2,
              tension: 0.4,
              fill: true
            },
            {
              label: 'Battery 2',
              data: filterLastHour(batteryData.history.temperature.battery_2).map(point => ({
                timestamp: new Date(point.timestamp),
                value: point.value
              })),
              backgroundColor: 'rgba(52, 152, 219, 0.1)',
              borderColor: '#3498db',
              borderWidth: 2,
              tension: 0.4,
              fill: true
            },
            {
              label: 'Battery 3',
              data: filterLastHour(batteryData.history.temperature.battery_3).map(point => ({
                timestamp: new Date(point.timestamp),
                value: point.value
              })),
              backgroundColor: 'rgba(243, 156, 18, 0.1)',
              borderColor: '#f39c12',
              borderWidth: 2,
              tension: 0.4,
              fill: true
            }
          ]
        },
        options: getChartOptions('Temperature (°F)')
      });
      
      // Voltage Chart (Line Chart)
      const voltageCtx = document.getElementById('voltageChart').getContext('2d');
      charts.voltage = new Chart(voltageCtx, {
        type: 'line',
        data: {
          datasets: [
            {
              label: 'Battery 1',
              data: filterLastHour(batteryData.history.voltage.battery_1).map(point => ({
                timestamp: new Date(point.timestamp),
                value: point.value
              })),
              backgroundColor: 'rgba(39, 174, 96, 0.1)',
              borderColor: '#27ae60',
              borderWidth: 2,
              tension: 0.4,
              fill: true
            },
            {
              label: 'Battery 2',
              data: filterLastHour(batteryData.history.voltage.battery_2).map(point => ({
                timestamp: new Date(point.timestamp),
                value: point.value
              })),
              backgroundColor: 'rgba(52, 152, 219, 0.1)',
              borderColor: '#3498db',
              borderWidth: 2,
              tension: 0.4,
              fill: true
            },
            {
              label: 'Battery 3',
              data: filterLastHour(batteryData.history.voltage.battery_3).map(point => ({
                timestamp: new Date(point.timestamp),
                value: point.value
              })),
              backgroundColor: 'rgba(243, 156, 18, 0.1)',
              borderColor: '#f39c12',
              borderWidth: 2,
              tension: 0.4,
              fill: true
            }
          ]
        },
        options: getChartOptions('Voltage (V)')
      });
      
      // Cell Balance Chart (bar chart showing current cell voltages)
      const cellCtx = document.getElementById('cellBalanceChart').getContext('2d');
      charts.cellBalance = new Chart(cellCtx, {
        type: 'bar',
        data: {
          labels: ['Battery 1 Avg', 'Battery 1 Max', 'Battery 1 Min',
                   'Battery 2 Avg', 'Battery 2 Max', 'Battery 2 Min',
                   'Battery 3 Avg', 'Battery 3 Max', 'Battery 3 Min'],
          datasets: [{
            label: 'Cell Voltage (V)',
            data: [
              batteryData.batteries[0].cellVoltage.average,
              batteryData.batteries[0].cellVoltage.highest,
              batteryData.batteries[0].cellVoltage.lowest,
              batteryData.batteries[1].cellVoltage.average,
              batteryData.batteries[1].cellVoltage.highest,
              batteryData.batteries[1].cellVoltage.lowest,
              batteryData.batteries[2].cellVoltage.average,
              batteryData.batteries[2].cellVoltage.highest,
              batteryData.batteries[2].cellVoltage.lowest
            ],
            backgroundColor: [
              '#27ae60', '#2ecc71', '#229954',
              '#3498db', '#5dade2', '#2874a6',
              '#f39c12', '#f5b041', '#d68910'
            ]
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            title: { display: false }
          },
          scales: {
            y: {
              beginAtZero: false,
              min: 3.2,
              max: 3.6,
              ticks: { color: '#a0a0a0' },
              grid: { color: 'rgba(255, 255, 255, 0.1)' }
            },
            x: {
              ticks: { color: '#a0a0a0', font: { size: 10 } },
              grid: { display: false }
            }
          }
        }
      });
    }
    
    function getChartOptions(yLabel) {
      return {
        responsive: true,
        maintainAspectRatio: false,
        parsing: {
          xAxisKey: 'timestamp',
          yAxisKey: 'value'
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: { color: '#a0a0a0' }
          },
          tooltip: {
            mode: 'index',
            intersect: false,
            filter: function(tooltipItem) {
              // Only show tooltips for visible datasets
              return !tooltipItem.dataset.hidden;
            }
          }
        },
        scales: {
          x: {
            type: 'time',
            time: {
              unit: 'minute',
              displayFormats: { minute: 'HH:mm' }
            },
            ticks: { color: '#a0a0a0' },
            grid: { color: 'rgba(255, 255, 255, 0.1)' }
          },
          y: {
            beginAtZero: false,
            ticks: { color: '#a0a0a0' },
            grid: { color: 'rgba(255, 255, 255, 0.1)' },
            title: {
              display: true,
              text: yLabel,
              color: '#a0a0a0'
            }
          }
        }
      };
    }
    
    function getBarChartOptions(yLabel) {
      return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: { color: '#a0a0a0' }
          }
        },
        scales: {
          x: {
            type: 'time',
            time: {
              unit: 'minute',
              displayFormats: { minute: 'HH:mm' }
            },
            ticks: { color: '#a0a0a0' },
            grid: { display: false },
            stacked: false,
            offset: true
          },
          y: {
            beginAtZero: true,
            ticks: { color: '#a0a0a0' },
            grid: { color: 'rgba(255, 255, 255, 0.1)' },
            title: {
              display: true,
              text: yLabel,
              color: '#a0a0a0'
            },
            stacked: false
          }
        },
        barPercentage: 0.6,
        categoryPercentage: 0.8,
        offset: true
      };
    }
    
    function filterLastHour(data) {
      if (!data || data.length === 0) return [];
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      return data.filter(point => new Date(point.timestamp).getTime() > oneHourAgo);
    }
    
    function changeBatteryView(chartType, view) {
      const chart = charts[chartType];
      if (!chart) return;
      
      // Hide/show datasets based on selection
      chart.data.datasets.forEach((dataset, index) => {
        if (view === 'all') {
          // Show all datasets
          dataset.hidden = false;
        } else if (view === 'battery1') {
          // Show only Battery 1 (index 0)
          dataset.hidden = (index !== 0);
        } else if (view === 'battery2') {
          // Show only Battery 2 (index 1)
          dataset.hidden = (index !== 1);
        } else if (view === 'battery3') {
          // Show only Battery 3 (index 2)
          dataset.hidden = (index !== 2);
        }
      });
      
      chart.update();
    }
    
    function updateBatteryValues() {
      // Update overview cards and battery cards with latest data
      updateOverviewCards();
      updateBatteryCards();
      
      // Update charts
      if (charts.power) {
        charts.power.data.datasets[0].data = filterLastHour(batteryData.history.power.battery_1);
        charts.power.data.datasets[1].data = filterLastHour(batteryData.history.power.battery_2);
        charts.power.data.datasets[2].data = filterLastHour(batteryData.history.power.battery_3);
        charts.power.update('none');
      }
      
      if (charts.temp) {
        charts.temp.data.datasets[0].data = filterLastHour(batteryData.history.temperature.battery_1);
        charts.temp.data.datasets[1].data = filterLastHour(batteryData.history.temperature.battery_2);
        charts.temp.data.datasets[2].data = filterLastHour(batteryData.history.temperature.battery_3);
        charts.temp.update('none');
      }
      
      if (charts.voltage) {
        charts.voltage.data.datasets[0].data = filterLastHour(batteryData.history.voltage.battery_1);
        charts.voltage.data.datasets[1].data = filterLastHour(batteryData.history.voltage.battery_2);
        charts.voltage.data.datasets[2].data = filterLastHour(batteryData.history.voltage.battery_3);
        charts.voltage.update('none');
      }
      
      if (charts.cellBalance) {
        charts.cellBalance.data.datasets[0].data = [
          batteryData.batteries[0].cellVoltage.average,
          batteryData.batteries[0].cellVoltage.highest,
          batteryData.batteries[0].cellVoltage.lowest,
          batteryData.batteries[1].cellVoltage.average,
          batteryData.batteries[1].cellVoltage.highest,
          batteryData.batteries[1].cellVoltage.lowest,
          batteryData.batteries[2].cellVoltage.average,
          batteryData.batteries[2].cellVoltage.highest,
          batteryData.batteries[2].cellVoltage.lowest
        ];
        charts.cellBalance.update('none');
      }
    }
  </script>
</body>
</html>
  `);
});

/**
 * GET /login - Login page
 * Serves login HTML (public route)
 */
app.get('/login', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Solar Dashboard - Login</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    :root {
      --bg-gradient-start: #1a1a2e;
      --bg-gradient-end: #16213e;
      --card-bg: #1e1e2e;
      --text-primary: #f0f0f0;
      --text-secondary: #d0d0d0;
      --text-muted: #a0a0a0;
      --border-color: #404050;
      --accent-color: #8fa3e8;
      --shadow-sm: 0 4px 12px rgba(0, 0, 0, 0.4);
      --shadow-lg: 0 10px 30px rgba(0, 0, 0, 0.5);
      --success-color: #4ade80;
      --warning-color: #fbbf24;
      --danger-color: #f87171;
      --solar-color: #fbbf24;
      --battery-color: #4ade80;
      --load-color: #60a5fa;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, var(--bg-gradient-start) 0%, var(--bg-gradient-end) 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: var(--text-primary);
    }
    
    .login-container {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      box-shadow: var(--shadow-lg);
      padding: 40px;
      width: 100%;
      max-width: 400px;
    }
    
    .logo {
      text-align: center;
      margin-bottom: 30px;
    }
    
    .logo h1 {
      color: var(--text-primary);
      font-size: 28px;
      margin-bottom: 8px;
      font-weight: 700;
    }
    
    .logo .sun-icon {
      display: inline-block;
      font-size: 24px;
      margin-right: 10px;
      color: var(--solar-color);
    }
    
    .logo p {
      color: var(--text-secondary);
      font-size: 14px;
    }
    
    .form-group {
      margin-bottom: 20px;
    }
    
    .form-group label {
      display: block;
      color: var(--text-primary);
      font-weight: 600;
      margin-bottom: 8px;
      font-size: 14px;
    }
    
    .form-group input {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid var(--border-color);
      border-radius: 8px;
      font-size: 14px;
      background: var(--card-bg);
      color: var(--text-primary);
      transition: border-color 0.3s, box-shadow 0.3s;
    }
    
    .form-group input:focus {
      outline: none;
      border-color: var(--accent-color);
      box-shadow: 0 0 0 3px rgba(143, 163, 232, 0.1);
    }
    
    .form-group input::placeholder {
      color: var(--text-muted);
    }
    
    .btn-login {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, var(--accent-color) 0%, #6b73ff 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    
    .btn-login:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(143, 163, 232, 0.4);
    }
    
    .btn-login:focus {
      outline: none;
      box-shadow: 0 0 0 3px rgba(143, 163, 232, 0.3);
    }
    
    .btn-login:active {
      transform: translateY(0);
    }
    
    .error-message {
      background: rgba(248, 113, 113, 0.1);
      border: 1px solid var(--danger-color);
      color: var(--danger-color);
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
      display: none;
    }
    
    .error-message.show {
      display: block;
    }
    
    .footer {
      text-align: center;
      margin-top: 20px;
      color: var(--text-muted);
      font-size: 12px;
    }
    
    /* High contrast mode support */
    @media (prefers-contrast: high) {
      :root {
        --border-color: #666;
        --text-primary: #ffffff;
        --text-secondary: #cccccc;
      }
      
      .form-group input:focus {
        box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.3);
      }
    }
    
    /* Reduced motion support */
    @media (prefers-reduced-motion: reduce) {
      * {
        transition: none !important;
        animation: none !important;
      }
    }
    
    /* Mobile responsive */
    @media (max-width: 480px) {
      .login-container {
        padding: 30px 20px;
        margin: 10px;
      }
      
      .logo h1 {
        font-size: 24px;
      }
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="logo">
      <h1><span class="sun-icon">☀️</span>Solar Dashboard</h1>
      <p>Login to access your system</p>
    </div>
    
    <div class="error-message" id="errorMessage"></div>
    
    <form id="loginForm">
      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" required autocomplete="username">
      </div>
      
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autocomplete="current-password">
      </div>
      
      <button type="submit" class="btn-login" id="loginBtn">Login</button>
    </form>
    
    <div class="footer">
      Protected by JWT Authentication
    </div>
  </div>
  
  <script>
    const form = document.getElementById('loginForm');
    const errorMessage = document.getElementById('errorMessage');
    const loginBtn = document.getElementById('loginBtn');
    
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      
      errorMessage.classList.remove('show');
      loginBtn.disabled = true;
      loginBtn.textContent = 'Logging in...';
      
      try {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
          window.location.href = '/';
        } else {
          errorMessage.textContent = data.error || 'Login failed';
          errorMessage.classList.add('show');
          loginBtn.disabled = false;
          loginBtn.textContent = 'Login';
        }
      } catch (error) {
        errorMessage.textContent = 'Network error. Please try again.';
        errorMessage.classList.add('show');
        loginBtn.disabled = false;
        loginBtn.textContent = 'Login';
      }
    });
  </script>
</body>
</html>
  `);
});

// ═══════════════════════════════════════════════════════════════════════════
// REST API ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE: Provide JSON API for dashboard to fetch data
// POLLING: Dashboard polls /data every 3 seconds for real-time updates
// SECURITY: All endpoints below require authentication via JWT

/**
 * GET /data - Returns current MQTT data snapshot
 * USED BY: Dashboard JavaScript (fetched every 3 seconds)
 * RETURNS: cachedData (latest value for each topic), weather, status
 * RELATIONSHIP: Returns data from MQTT message handler (cachedData object)
 */
app.get('/data', authenticateToken, (req, res) => {
  if (Object.keys(cachedData).length === 0) {
    return res.status(503).json({
      error: 'No data available yet',
      status: connectionStatus,
      messageCount: messageCount
    });
  }
  
  res.json({
    data: cachedData,
    lastUpdate: lastUpdate,
    messageCount: messageCount,
    status: connectionStatus,
    topics: Object.keys(cachedData).length,
    weather: weatherData,
    chargerState: chargerState
  });
});

/**
 * GET /data/history - Returns time-series data for charts
 * USED BY: Dashboard on initial page load
 * RETURNS: historicalData arrays for TRACKED_TOPICS
 * RELATIONSHIP: Data from MQTT → historicalData → This endpoint → Chart.js
 * NOTE: Can be large (365 days * 5 topics * ~86400 data points/day)
 */
app.get('/data/history', authenticateToken, (req, res) => {
  res.json({
    data: historicalData,
    trackedTopics: TRACKED_TOPICS,
    dataPoints: Object.values(historicalData).reduce((sum, arr) => sum + arr.length, 0),
    retentionDays: DATA_RETENTION_DAYS
  });
});

/**
 * API endpoint - get peak performance for time range
 */
app.get('/data/peak-performance', authenticateToken, (req, res) => {
  const hours = parseFloat(req.query.hours) || null;
  res.json({
    peak: getPeakPerformance(hours)
  });
});

/**
 * API endpoint - get daily statistics
 */
app.get('/data/daily-stats', authenticateToken, (req, res) => {
  // Get earliest data point time for today
  let earliestTime = null;
  const topic = 'solar_assistant/inverter_1/pv_power/state';
  if (historicalData[topic] && historicalData[topic].length > 0) {
    const today = new Date().toDateString();
    const todayData = historicalData[topic].filter(point => {
      return new Date(point.timestamp).toDateString() === today;
    });
    if (todayData.length > 0) {
      earliestTime = new Date(todayData[0].timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    }
  }
  
  res.json({
    energyProduced: getDailyEnergyProduced(),
    energyConsumed: getDailyEnergyConsumed(),
    batteryRuntime: getBatteryRuntime(),
    peakPerformance: getPeakPerformance(1), // Peak for past hour (default time period)
    peakPower: dailyStats.peakPower,
    date: dailyStats.date,
    trackingStartTime: earliestTime || 'Just started'
  });
});

/**
 * API endpoint - get comprehensive battery data
 */
app.get('/data/battery', authenticateToken, (req, res) => {
  // Get current values for all battery metrics
  const batteryData = {
    // Total battery metrics
    total: {
      soc: parseFloat(cachedData['solar_assistant/total/battery_state_of_charge/state']?.value) || null,
      power: parseFloat(cachedData['solar_assistant/total/battery_power/state']?.value) || null,
      temperature: parseFloat(cachedData['solar_assistant/total/battery_temperature/state']?.value) || null,
      energyIn: parseFloat(cachedData['solar_assistant/total/battery_energy_in/state']?.value) || null,
      energyOut: parseFloat(cachedData['solar_assistant/total/battery_energy_out/state']?.value) || null,
      voltage: parseFloat(cachedData['solar_assistant/inverter_1/battery_voltage/state']?.value) || null,
      current: parseFloat(cachedData['solar_assistant/inverter_1/battery_current/state']?.value) || null
    },
    
    // Individual battery data
    batteries: [1, 2, 3].map(num => {
      return {
        id: num,
        voltage: parseFloat(cachedData[`solar_assistant/battery_${num}/voltage/state`]?.value) || null,
        current: parseFloat(cachedData[`solar_assistant/battery_${num}/current/state`]?.value) || null,
        power: parseFloat(cachedData[`solar_assistant/battery_${num}/power/state`]?.value) || null,
        temperature: parseFloat(cachedData[`solar_assistant/battery_${num}/temperature/state`]?.value) || null,
        soc: parseFloat(cachedData[`solar_assistant/battery_${num}/state_of_charge/state`]?.value) || null,
        soh: parseFloat(cachedData[`solar_assistant/battery_${num}/state_of_health/state`]?.value) || null,
        capacity: parseFloat(cachedData[`solar_assistant/battery_${num}/capacity/state`]?.value) || null,
        chargeCapacity: parseFloat(cachedData[`solar_assistant/battery_${num}/charge_capacity/state`]?.value) || null,
        cellVoltage: {
          average: parseFloat(cachedData[`solar_assistant/battery_${num}/cell_voltage_-_average/state`]?.value) || null,
          highest: parseFloat(cachedData[`solar_assistant/battery_${num}/cell_voltage_-_highest/state`]?.value) || null,
          lowest: parseFloat(cachedData[`solar_assistant/battery_${num}/cell_voltage_-_lowest/state`]?.value) || null
        }
      };
    }),
    
    // Historical data for charting
    history: {
      voltage: [1, 2, 3].reduce((acc, num) => {
        acc[`battery_${num}`] = historicalData[`solar_assistant/battery_${num}/voltage/state`] || [];
        return acc;
      }, {}),
      current: [1, 2, 3].reduce((acc, num) => {
        acc[`battery_${num}`] = historicalData[`solar_assistant/battery_${num}/current/state`] || [];
        return acc;
      }, {}),
      temperature: [1, 2, 3].reduce((acc, num) => {
        acc[`battery_${num}`] = historicalData[`solar_assistant/battery_${num}/temperature/state`] || [];
        return acc;
      }, {}),
      power: [1, 2, 3].reduce((acc, num) => {
        acc[`battery_${num}`] = historicalData[`solar_assistant/battery_${num}/power/state`] || [];
        return acc;
      }, {}),
      soc: [1, 2, 3].reduce((acc, num) => {
        acc[`battery_${num}`] = historicalData[`solar_assistant/battery_${num}/state_of_charge/state`] || [];
        return acc;
      }, {}),
      totalPower: historicalData['solar_assistant/total/battery_power/state'] || [],
      totalSoc: historicalData['solar_assistant/total/battery_state_of_charge/state'] || [],
      totalTemp: historicalData['solar_assistant/total/battery_temperature/state'] || []
    }
  };
  
  res.json(batteryData);
});

/**
 * API endpoint - get alert history
 */
app.get('/settings/alerts/history', authenticateToken, (req, res) => {
  res.json({
    history: alertHistory.slice(0, 10) // Return last 10 alerts
  });
});

/**
 * GET /settings/alerts - Returns alert settings and system state
 * USED BY: Dashboard Settings modal
 * SECURITY: Masks API keys (only shows last 8 characters)
 * RETURNS: alertSettings, alertState, chargerState, alertHistory
 */
app.get('/settings/alerts', authenticateToken, (req, res) => {
  res.json({
    settings: {
      ...alertSettings,
      sendgridApiKey: alertSettings.sendgridApiKey ? '***' + alertSettings.sendgridApiKey.slice(-8) : null, // Mask API key
      chargerControl: {
        ...alertSettings.chargerControl,
        iftttWebhookKey: alertSettings.chargerControl.iftttWebhookKey ? '***' + alertSettings.chargerControl.iftttWebhookKey.slice(-8) : null
      }
    },
    state: alertState,
    chargerState: chargerState,
    history: alertHistory.slice(0, 10)
  });
});

/**
 * POST /settings/alerts - Update alert settings
 * USED BY: Dashboard Settings modal "Save Settings" button
 * IMPACT: Modifies alertSettings object and saves to SETTINGS_FILE
 * SECURITY: Validates and sanitizes input before saving
 * RELATIONSHIP: Updated settings immediately affect alert logic and charger control
 */
app.post('/settings/alerts', authenticateToken, (req, res) => {
  try {
    const { enabled, fromEmail, toEmail, lowThreshold, highThreshold, sendgridApiKey, chargerControl } = req.body;
    
    if (enabled !== undefined) alertSettings.enabled = enabled;
    if (fromEmail) alertSettings.fromEmail = fromEmail;
    if (toEmail) alertSettings.toEmail = toEmail;
    if (lowThreshold !== undefined) alertSettings.lowThreshold = parseFloat(lowThreshold);
    if (highThreshold !== undefined) alertSettings.highThreshold = parseFloat(highThreshold);
    if (sendgridApiKey && sendgridApiKey !== '***') alertSettings.sendgridApiKey = sendgridApiKey;
    
    // Update charger control settings
    if (chargerControl) {
      if (chargerControl.enabled !== undefined) alertSettings.chargerControl.enabled = chargerControl.enabled;
      if (chargerControl.lowThreshold !== undefined) alertSettings.chargerControl.lowThreshold = parseFloat(chargerControl.lowThreshold);
      if (chargerControl.highThreshold !== undefined) alertSettings.chargerControl.highThreshold = parseFloat(chargerControl.highThreshold);
      if (chargerControl.plugName) alertSettings.chargerControl.plugName = chargerControl.plugName;
      if (chargerControl.maxTemp !== undefined) alertSettings.chargerControl.maxTemp = parseFloat(chargerControl.maxTemp);
      if (chargerControl.iftttWebhookKey && chargerControl.iftttWebhookKey !== '***') {
        alertSettings.chargerControl.iftttWebhookKey = chargerControl.iftttWebhookKey;
      }
    }
    
    saveAlertSettings();
    
    res.json({
      success: true,
      settings: {
        ...alertSettings,
        sendgridApiKey: alertSettings.sendgridApiKey ? '***' + alertSettings.sendgridApiKey.slice(-8) : null,
        chargerControl: {
          ...alertSettings.chargerControl,
          iftttWebhookKey: alertSettings.chargerControl.iftttWebhookKey ? '***' + alertSettings.chargerControl.iftttWebhookKey.slice(-8) : null
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API endpoint - send test email
 */
app.post('/settings/alerts/test', authenticateToken, async (req, res) => {
  try {
    const currentSOC = cachedData['solar_assistant/total/battery_state_of_charge/state']?.value || 'N/A';
    const currentPV = cachedData['solar_assistant/inverter_1/pv_power/state']?.value || 'N/A';
    const currentLoad = cachedData['solar_assistant/inverter_1/load_power/state']?.value || 'N/A';
    
    const result = await sendEmailAlert(
      '🧪 Test Alert - SolarAssistant Dashboard',
      `This is a test email from your SolarAssistant Dashboard.\\n\\nCurrent Status:\\n- Battery SOC: ${currentSOC}%\\n- Solar Power: ${currentPV}W\\n- Load Power: ${currentLoad}W\\n\\nTime: ${new Date().toLocaleString()}\\n\\nIf you received this email, your alert system is working correctly!`
    );
    
    if (result) {
      res.json({ success: true, message: 'Test email sent successfully!' });
    } else {
      res.json({ success: false, message: 'Failed to send test email. Check console for errors.' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * API endpoint - test alert thresholds with simulated SOC values
 */
app.post('/settings/alerts/test-threshold', authenticateToken, async (req, res) => {
  try {
    const { soc } = req.body;
    
    if (!soc || isNaN(parseFloat(soc))) {
      return res.status(400).json({ success: false, message: 'Invalid SOC value. Please provide a number.' });
    }
    
    const socValue = parseFloat(soc);
    
    // Simulate the alert check with the provided SOC value
    await checkBatteryAlerts(socValue);
    
    // Also test charger control if enabled
    await controlBatteryCharger(socValue);
    
    res.json({ 
      success: true, 
      message: `Alert and charger check triggered with SOC: ${socValue}%`,
      currentState: {
        belowThreshold: alertState.belowThreshold,
        lastAlertType: alertState.lastAlertType,
        lastAlertTime: alertState.lastAlertTime,
        lowThreshold: alertSettings.lowThreshold,
        highThreshold: alertSettings.highThreshold
      },
      chargerState: {
        ...chargerState,
        chargerEnabled: alertSettings.chargerControl.enabled
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /settings/charger/test - Manually trigger IFTTT charger control
 * USED BY: Dashboard "Test Charger Control" buttons
 * IMPACT: Sends IFTTT webhook (battery_low or battery_charged event)
 * SIDE EFFECTS: Updates chargerState, sends email alert, saves to dailyStats
 * PURPOSE: Test IFTTT integration without waiting for actual battery thresholds
 * @param {string} action - 'on' or 'off'
 */
app.post('/settings/charger/test', authenticateToken, async (req, res) => {
  try {
    const { action } = req.body;
    
    if (!action || !['on', 'off'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Invalid action. Use "on" or "off".' });
    }
    
    if (!alertSettings.chargerControl?.enabled) {
      return res.status(400).json({ 
        success: false, 
        message: 'Charger control is not enabled. Please enable it in settings first.' 
      });
    }
    
    if (!alertSettings.chargerControl?.iftttWebhookKey) {
      return res.status(400).json({ 
        success: false, 
        message: 'IFTTT webhook key is not configured.' 
      });
    }
    
    const webhookKey = alertSettings.chargerControl.iftttWebhookKey;
    const event = action === 'on' ? 'battery_low' : 'battery_charged';
    const url = `https://maker.ifttt.com/trigger/${event}/with/key/${webhookKey}`;
    
    console.log(`🧪 TEST: Triggering charger ${action.toUpperCase()} via IFTTT...`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value1: 'Manual Test',
        value2: new Date().toLocaleString(),
        value3: action === 'on' ? 'Testing ON command' : 'Testing OFF command'
      })
    });
    
    if (response.ok) {
      // Update charger state
      chargerState.isOn = (action === 'on');
      chargerState.lastAction = action;
      chargerState.lastActionTime = Date.now();
      chargerState.lastActionReason = 'Manual test';
      
      saveDailyStats();
      
      console.log(`✅ TEST: Charger ${action.toUpperCase()} command sent successfully`);
      
      // Send email notification for test trigger
      const currentSOC = cachedData['solar_assistant/total/battery_state_of_charge/state']?.value || 'N/A';
      const emailSubject = action === 'on' 
        ? '🧪 Test: Battery Charger ON Command Sent' 
        : '🧪 Test: Battery Charger OFF Command Sent';
      const emailMessage = action === 'on'
        ? `A manual test command was sent to turn the battery charger ON via IFTTT.\n\nTrigger Event: battery_low\nCurrent Battery SOC: ${currentSOC}%\nPlug: ${alertSettings.chargerControl.plugName}\nTime: ${new Date().toLocaleString()}\n\nThis was a MANUAL TEST - not an automatic trigger.`
        : `A manual test command was sent to turn the battery charger OFF via IFTTT.\n\nTrigger Event: battery_charged\nCurrent Battery SOC: ${currentSOC}%\nPlug: ${alertSettings.chargerControl.plugName}\nTime: ${new Date().toLocaleString()}\n\nThis was a MANUAL TEST - not an automatic trigger.`;
      
      await sendEmailAlert(emailSubject, emailMessage);
      
      res.json({ 
        success: true, 
        message: `Charger ${action.toUpperCase()} command sent successfully!`,
        chargerState: chargerState
      });
    } else {
      throw new Error(`IFTTT webhook returned status ${response.status}`);
    }
  } catch (error) {
    console.error('❌ TEST: Error testing charger control:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Test endpoint for daily summary
 */
app.post('/settings/daily-summary/test', authenticateToken, async (req, res) => {
  try {
    console.log('🧪 TEST: Sending test daily summary report...');
    
    const success = await sendDailySummaryReport();
    
    if (success) {
      res.json({ 
        success: true, 
        message: 'Test daily summary sent successfully! Check your email.' 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to send daily summary. Check console for details.' 
      });
    }
  } catch (error) {
    console.error('❌ TEST: Error sending test daily summary:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Homepage - displays charts and current data
 * PROTECTED: Requires authentication, redirects to /login if not authenticated
 */
app.get('/', requireAuth, (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
  <meta http-equiv="Pragma" content="no-cache">
  <meta http-equiv="Expires" content="0">
  <title>SolarAssistant Dashboard</title>
  <!-- CSS Version: 8.19.0 - Chart Tooltips Addition -->
  <script>
    // Aggressive cache busting - Add timestamp to URL if not present
    if (!window.location.search.includes('v=')) {
      const timestamp = Date.now();
      window.location.href = window.location.pathname + '?v=' + timestamp;
    }
  </script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js"></script>
  <style>
    :root {
      --bg-gradient-start: #667eea;
      --bg-gradient-end: #764ba2;
      --card-bg: white;
      --text-primary: #333;
      --text-secondary: #666;
      --text-muted: #999;
      --border-color: #e0e0e0;
      --accent-color: #667eea;
      --shadow-sm: 0 4px 12px rgba(0, 0, 0, 0.15);
      --shadow-lg: 0 10px 30px rgba(0, 0, 0, 0.2);
      --success-color: #28a745;
      --warning-color: #ffc107;
      --danger-color: #dc3545;
      --solar-color: #f39c12;
      --battery-color: #27ae60;
      --load-color: #3498db;
    }
    
    [data-theme="dark"] {
      --bg-gradient-start: #1a1a2e;
      --bg-gradient-end: #16213e;
      --card-bg: #1e1e2e;
      --text-primary: #f0f0f0;
      --text-secondary: #d0d0d0;
      --text-muted: #a0a0a0;
      --border-color: #404050;
      --accent-color: #8fa3e8;
      --shadow-sm: 0 4px 12px rgba(0, 0, 0, 0.4);
      --shadow-lg: 0 10px 30px rgba(0, 0, 0, 0.5);
      --success-color: #4ade80;
      --warning-color: #fbbf24;
      --danger-color: #f87171;
      --solar-color: #fbbf24;
      --battery-color: #4ade80;
      --load-color: #60a5fa;
    }
    
    [data-theme="dark"] .value-card {
      background: #29293c;
    }
    
    [data-theme="dark"] .chart-wrapper {
      background: #29293c;
      border-radius: 8px;
      padding: 20px;
    }
    
    [data-theme="dark"] .status-item {
      background: #29293c;
    }
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(135deg, var(--bg-gradient-start) 0%, var(--bg-gradient-end) 100%);
      min-height: 100vh;
      padding: 20px;
      transition: background 0.3s ease, color 0.3s ease;
    }
    
    @media (max-width: 768px) {
      body {
        padding: 10px;
      }
    }
    
    .container {
      max-width: 1600px;
      margin: 0 auto;
    }
    
    
    .header {
      position: relative;
      background: var(--card-bg);
      border-radius: 12px;
      padding: 30px 160px 30px 30px;
      margin-bottom: 20px;
      box-shadow: var(--shadow-lg);
      transition: background 0.3s ease;
    }
    
    @media (max-width: 768px) {
      .header {
        padding: 20px 140px 20px 20px;
      }
    }
    
    .theme-toggle-btn {
      position: absolute;
      top: 20px;
      right: 70px;
      background: var(--card-bg);
      color: var(--accent-color);
      border: 2px solid var(--border-color);
      border-radius: 50%;
      width: 40px;
      height: 40px;
      font-size: 20px;
      cursor: pointer;
      box-shadow: var(--shadow-sm);
      transition: all 0.3s ease;
      z-index: 1001;
    }
    
    .theme-toggle-btn:hover {
      background: var(--accent-color);
      color: var(--card-bg);
      transform: scale(1.1);
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.15);
    }
    
    @media (max-width: 768px) {
      .theme-toggle-btn {
        top: 10px;
        right: 20px;
        width: 32px;
        height: 32px;
        font-size: 16px;
      }
    }
    
    .time-period-selector {
      margin: 20px 0;
      text-align: center;
    }
    
    .time-period-selector label {
      font-weight: bold;
      color: var(--text-primary);
      margin-right: 10px;
      font-size: 16px;
    }
    
    .time-period-selector select {
      padding: 8px 12px;
      border: 2px solid var(--border-color);
      border-radius: 8px;
      background: var(--card-bg);
      font-size: 14px;
      color: var(--text-primary);
      cursor: pointer;
      transition: all 0.3s ease;
    }
    
    .time-period-selector select:hover {
      border-color: #667eea;
    }
    
    .time-period-selector select:focus {
      outline: none;
      border-color: var(--accent-color);
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }
    
    .chart-selector-label {
      font-size: 14px;
      color: var(--text-secondary);
      font-weight: 500;
    }
    
    .chart-selector {
      padding: 6px 12px;
      border: 2px solid var(--border-color);
      border-radius: 8px;
      background: var(--card-bg);
      font-size: 14px;
      color: var(--text-primary);
      cursor: pointer;
      transition: all 0.3s ease;
    }
    
    .chart-selector:hover {
      border-color: var(--accent-color);
    }
    
    .chart-selector:focus {
      outline: none;
      border-color: var(--accent-color);
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }
    
    h1 {
      color: var(--text-primary);
      font-size: 32px;
      margin-bottom: 10px;
    }
    
    @media (max-width: 768px) {
      h1 {
        font-size: 24px;
      }
    }
    
    .status {
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
      margin-top: 15px;
    }
    
    @media (max-width: 768px) {
      .status {
        gap: 10px;
      }
    }
    
    .status-item {
      background: var(--bg-gradient-start);
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 14px;
      color: white;
    }
    
    @media (max-width: 768px) {
      .status-item {
        padding: 8px 15px;
        font-size: 12px;
      }
    }
    
    .status-label {
      color: rgba(255, 255, 255, 0.9);
      font-weight: 500;
    }
    
    /* Light mode specific styles for status items */
    [data-theme="light"] .status-item {
      background: #e0e0e0;
    }
    
    [data-theme="light"] .status-label {
      color: #333333;
    }
    
    [data-theme="light"] .status-value {
      color: #333333;
    }
    
    .status-value {
      color: white;
      font-weight: 600;
      margin-left: 5px;
    }
    
    .success {
      color: var(--success-color) !important;
    }
    
    .warning {
      color: var(--warning-color) !important;
    }
    
    .error {
      color: var(--danger-color) !important;
    }
    
    .current-values {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 15px;
    }
    
    @media (max-width: 768px) {
      .current-values {
        grid-template-columns: repeat(2, 1fr) !important;
        gap: 10px;
      }
      
      .value-card {
        font-size: 0.9em;
      }
    }
    
    .value-card {
      background: var(--card-bg);
      border-radius: 8px;
      padding: 12px;
      box-shadow: var(--shadow-sm);
      cursor: grab;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    
    .value-card:active {
      cursor: grabbing;
    }
    
    .value-card.sortable-ghost {
      opacity: 0.4;
    }
    
    .value-card.sortable-drag {
      transform: rotate(2deg);
      box-shadow: var(--shadow-lg);
    }
    
    .value-card h3 {
      color: var(--text-secondary);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      margin-bottom: 6px;
    }
    
    .value-card .value {
      font-size: 24px;
      font-weight: bold;
      color: var(--text-primary);
      margin-bottom: 3px;
    }
    
    .value-card .unit {
      color: var(--text-muted);
      font-size: 12px;
      font-weight: normal;
    }
    
    .value-card .updated {
      color: var(--text-muted);
      font-size: 9px;
      margin-top: 6px;
    }
    
    [data-theme="dark"] .value-card .updated {
      color: #ffffff;
    }
    
    /* Solar Array Chart Styles */
    .solar-array-chart {
      margin: 8px 0;
      height: 12px;
    }
    
    .chart-bar {
      width: 100%;
      height: 12px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      overflow: hidden;
      display: flex;
    }
    
    .bar-segment {
      height: 100%;
      transition: width 0.3s ease;
    }
    
    .bar-segment.array1 {
      background-color: #20b2aa;
    }
    
    .bar-segment.array2 {
      background-color: #8e44ad;
    }
    
    [data-theme="dark"] .chart-bar {
      background: rgba(0, 0, 0, 0.3);
    }
    
    /* Array Performance Chart Styles */
    .array-performance-chart {
      margin: 8px 0;
      height: 12px;
      position: relative;
    }
    
    .performance-bar {
      width: 100%;
      height: 12px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      overflow: hidden;
      position: relative;
      cursor: pointer;
    }
    
    .performance-fill {
      height: 100%;
      border-radius: 6px;
      transition: width 0.3s ease;
    }
    
    .performance-fill.array1 {
      background-color: #20b2aa;
    }
    
    .performance-fill.array2 {
      background-color: #8e44ad;
    }
    
    [data-theme="dark"] .performance-bar {
      background: rgba(0, 0, 0, 0.3);
    }
    
    /* Chart Tooltip Styles */
    .chart-tooltip {
      position: absolute;
      background: rgba(0, 0, 0, 0.9);
      color: white;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: bold;
      pointer-events: none;
      z-index: 1000;
      opacity: 0;
      transition: opacity 0.2s ease;
      white-space: nowrap;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }
    
    .chart-tooltip.show {
      opacity: 1;
    }
    
    .chart-tooltip::after {
      content: '';
      position: absolute;
      top: 100%;
      left: 50%;
      margin-left: -5px;
      border: 5px solid transparent;
      border-top-color: rgba(0, 0, 0, 0.9);
    }
    
    /* Status Chart Styles */
    .status-chart {
      display: flex;
      gap: 2px;
      margin-top: 8px;
      height: 12px;
      align-items: center;
    }
    
    .status-bar {
      flex: 1;
      height: 8px;
      border-radius: 2px;
      transition: background-color 0.3s ease;
    }
    
    .status-bar.pending {
      background-color: #4a4e5a;
    }
    
    .status-bar.danger {
      background-color: #f87171;
    }
    
    .status-bar.warning {
      background-color: #fbbf24;
    }
    
    .status-bar.up {
      background-color: #20b2aa;
    }
    
    /* Dark theme status bar colors */
    [data-theme="dark"] .status-bar.pending {
      background-color: #4a4e5a;
    }
    
    [data-theme="dark"] .status-bar.danger {
      background-color: #f87171;
    }
    
    [data-theme="dark"] .status-bar.warning {
      background-color: #fbbf24;
    }
    
    [data-theme="dark"] .status-bar.up {
      background-color: #20b2aa;
    }
    
    /* Help Icon Styles */
    .help-icon {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 16px;
      height: 16px;
      color: #20b2aa;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: bold;
      cursor: help;
      opacity: 0.8;
      transition: all 0.2s ease;
      z-index: 10;
      background: none;
      border: none;
    }
    
    .help-icon:hover {
      opacity: 1;
      color: #20b2aa;
      transform: scale(1.2);
    }
    
    /* Tooltip Styles */
    .tooltip {
      position: relative;
    }
    
    .tooltip-popup {
      position: fixed;
      background: var(--card-bg);
      color: var(--text-primary);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.3;
      opacity: 0;
      visibility: hidden;
      transition: all 0.3s ease;
      z-index: 1000;
      border: 1px solid var(--border-color);
      box-shadow: var(--shadow-lg);
      width: 250px;
      white-space: normal;
      text-align: left;
      pointer-events: none;
      word-wrap: break-word;
      overflow-wrap: break-word;
      box-sizing: border-box;
      /* Position will be set by JavaScript */
    }
    
    /* Mobile-specific tooltip sizing */
    @media (max-width: 768px) {
      .tooltip-popup {
        width: 200px;
        font-size: 11px;
        padding: 6px 10px;
        line-height: 1.2;
      }
    }
    
    .tooltip-popup.show {
      opacity: 1;
      visibility: visible;
    }
    
    .weather-card { border-left: 3px solid #e74c3c; }
    .pv-power { border-left: 3px solid #f39c12; }
    .battery-soc { border-left: 3px solid #27ae60; }
    .load-power { border-left: 3px solid #3498db; }
    
    .weather-details {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      margin-top: 8px;
      font-size: 9px;
    }
    
    .weather-detail {
      color: #666;
      font-weight: 500;
    }
    
    [data-theme="dark"] .weather-detail {
      color: #d0d0d0;
    }
    
    
    

         .battery-btn {
           position: absolute;
           top: 20px;
           right: 170px;
           background: var(--card-bg);
           color: #27ae60;
           border: 2px solid var(--border-color);
           border-radius: 50%;
           width: 40px;
           height: 40px;
           font-size: 20px;
           cursor: pointer;
           box-shadow: var(--shadow-sm);
           transition: all 0.3s ease;
           z-index: 1001;
         }
    
         .battery-btn:hover {
           background: #27ae60;
           color: white;
           border-color: #27ae60;
           transform: scale(1.1);
           box-shadow: 0 6px 16px rgba(39, 174, 96, 0.3);
         }

         .settings-btn {
           position: absolute;
           top: 20px;
           right: 120px;
           background: var(--card-bg);
           color: var(--accent-color);
           border: 2px solid var(--border-color);
           border-radius: 50%;
           width: 40px;
           height: 40px;
           font-size: 20px;
           cursor: pointer;
           box-shadow: var(--shadow-sm);
           transition: all 0.3s ease;
           z-index: 1001;
         }
    
         .settings-btn:hover {
           background: var(--accent-color);
           color: var(--card-bg);
           border-color: var(--accent-color);
           transform: rotate(90deg);
           box-shadow: 0 6px 16px rgba(0, 0, 0, 0.15);
         }
         
         .logout-btn {
           position: absolute;
           top: 20px;
           right: 20px;
           background: var(--card-bg);
           color: var(--danger-color);
           border: 2px solid var(--border-color);
           border-radius: 50%;
           width: 40px;
           height: 40px;
           font-size: 20px;
           cursor: pointer;
           box-shadow: var(--shadow-sm);
           transition: all 0.3s ease;
           z-index: 1001;
         }
    
         .logout-btn:hover {
           background: var(--danger-color);
           color: white;
           border-color: var(--danger-color);
           transform: scale(1.1);
           box-shadow: 0 6px 16px rgba(220, 53, 69, 0.3);
         }
         
         @media (max-width: 768px) {
           .battery-btn {
             top: 10px;
             right: 72px;
             width: 32px;
             height: 32px;
             font-size: 16px;
           }
           
           .settings-btn {
             top: 10px;
             right: 46px;
             width: 32px;
             height: 32px;
             font-size: 16px;
           }
           
           .logout-btn {
             top: 10px;
             right: 20px;
             width: 32px;
             height: 32px;
             font-size: 16px;
           }
         }
    
    .modal {
      display: none;
      position: fixed;
      z-index: 1000;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(5px);
    }
    
    .modal-content {
      background-color: var(--card-bg);
      margin: 5% auto;
      padding: 30px;
      border-radius: 12px;
      width: max(700px, 70vw);
      max-width: 95vw;
      max-height: 85vh;
      overflow-y: auto;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      animation: slideDown 0.3s ease;
    }
    
    .modal-content h2 {
      color: var(--text-primary);
    }
    
    @media (max-width: 768px) {
      .modal-content {
        width: 95vw;
        padding: 20px;
        margin: 10% auto;
      }
    }
    
    @keyframes slideDown {
      from {
        transform: translateY(-50px);
        opacity: 0;
      }
      to {
        transform: translateY(0);
        opacity: 1;
      }
    }
    
    .close {
      color: #aaa;
      float: right;
      font-size: 28px;
      font-weight: bold;
      cursor: pointer;
      line-height: 20px;
    }
    
    .close:hover {
      color: var(--text-primary);
    }
    
    [data-theme="dark"] .close {
      color: #d0d0d0;
    }
    
    [data-theme="dark"] .close:hover {
      color: #f0f0f0;
    }
    
    .settings-form {
      margin-top: 20px;
    }
    
    .form-group {
      margin-bottom: 20px;
    }
    
    .form-group label {
      display: block;
      font-weight: bold;
      margin-bottom: 8px;
      color: var(--text-primary);
    }
    
    .form-group input[type="email"],
    .form-group input[type="number"],
    .form-group input[type="checkbox"] {
      width: 100%;
      padding: 10px;
      border: 2px solid var(--border-color);
      border-radius: 8px;
      font-size: 14px;
      box-sizing: border-box;
      background: var(--card-bg);
      color: var(--text-primary);
    }
    
    .form-group input[type="checkbox"] {
      width: auto;
    }
    
    .form-group input[type="email"]:focus,
    .form-group input[type="number"]:focus {
      outline: none;
      border-color: var(--accent-color);
    }
    
    .form-group small {
      display: block;
      color: var(--text-muted);
      font-size: 12px;
      margin-top: 5px;
    }
    
    .alert-state {
      background: var(--bg-gradient-start);
      padding: 12px;
      border-radius: 8px;
      margin: 20px 0;
      color: white;
      font-size: 14px;
      text-align: center;
    }
    
    .alert-history-title {
      color: var(--text-primary);
      font-size: 16px;
      margin-bottom: 10px;
    }
    
    .alert-history-container {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 10px;
    }
    
    [data-theme="dark"] .alert-history-container {
      background: #252535;
      border-color: #404050;
    }
    
    .alert-history-table {
      width: 100%;
      font-size: 12px;
      border-collapse: collapse;
    }
    
    .alert-history-table thead tr {
      background: var(--border-color);
      border-bottom: 2px solid var(--border-color);
    }
    
    [data-theme="dark"] .alert-history-table thead tr {
      background: #2a2a3e;
    }
    
    .alert-history-table th {
      padding: 8px;
      text-align: left;
      color: var(--text-primary);
      font-weight: 600;
    }
    
    .alert-history-table td {
      padding: 8px;
      border-bottom: 1px solid var(--border-color);
      color: var(--text-primary);
    }
    
    .alert-history-table .time-cell {
      color: var(--text-secondary);
    }
    
    .alert-history-empty {
      text-align: center;
      color: var(--text-muted);
      padding: 20px;
    }
    
    .form-actions {
      display: flex;
      gap: 10px;
      margin-top: 20px;
    }
    
    .btn-primary,
    .btn-secondary,
    .btn-test {
      flex: 1;
      padding: 12px 24px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: bold;
      cursor: pointer;
      transition: all 0.3s ease;
    }
    
    .btn-primary {
      background: var(--accent-color);
      color: white;
    }
    
    .btn-primary:hover {
      background: #5568d3;
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
    }
    
    .btn-test {
      background: var(--success-color);
      color: white;
    }
    
    .btn-test:hover {
      background: #229954;
      box-shadow: 0 4px 12px rgba(39, 174, 96, 0.3);
    }
    
    .btn-secondary {
      background: var(--border-color);
      color: var(--text-primary);
    }
    
    .btn-secondary:hover {
      background: #d0d0d0;
    }
    
    .charts-container {
      background: var(--card-bg);
      border-radius: 12px;
      padding: 30px;
      margin-bottom: 20px;
      box-shadow: var(--shadow-lg);
    }
    
    @media (max-width: 768px) {
      .charts-container {
        padding: 10px;
      }
    }
    
    .chart-wrapper {
      margin-bottom: 40px;
      position: relative;
    }
    
    .chart-wrapper:last-child {
      margin-bottom: 0;
    }
    
    .chart-wrapper h2 {
      color: var(--text-primary);
      font-size: 20px;
      margin-bottom: 20px;
    }
    
    @media (max-width: 768px) {
      .chart-wrapper h2 {
        font-size: 16px;
      }
    }
    
    .chart-container {
      position: relative;
      height: 200px;
      width: 100%;
    }
    
    .chart-wrapper {
      background: var(--card-bg);
      border-radius: 12px;
      padding: 30px;
      margin-bottom: 20px;
      box-shadow: var(--shadow-lg);
      width: 100%;
    }
    
    @media (max-width: 768px) {
      .chart-wrapper {
        padding: 20px;
      }
    }
    
    
    .loading {
      text-align: center;
      padding: 40px;
      color: #666;
    }
    
    .value-card button:hover {
      background: #2980b9 !important;
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(52, 152, 219, 0.3);
    }
    
    .value-card button:active {
      transform: translateY(0);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <button class="theme-toggle-btn" onclick="toggleTheme()" title="Toggle Dark Mode">🌙</button>
      <button class="battery-btn" onclick="window.location.href='/battery'" title="Battery Details">🔋</button>
      <button class="settings-btn" onclick="window.location.href='/settings-page'" title="Settings">⚙️</button>
      <button class="logout-btn" onclick="logout()" title="Logout">🚪</button>
      <h1>☀️ SolarAssistant Dashboard <span style="font-size: 14px; color: var(--text-muted); font-weight: normal;">v8.20.2</span></h1>
      <div class="time-period-selector">
        <label for="timePeriod">📊 Time Period:</label>
            <select id="timePeriod" onchange="changeTimePeriod(this.value)">
              <option value="" selected>--- Select a Time Period ---</option>
              <option value="1hour">Past 1 Hour</option>
              <option value="12hours">Past 12 Hours</option>
              <option value="24hours">Past 24 Hours</option>
              <option value="48hours">Past 48 Hours</option>
              <option value="7days">Past 7 Days</option>
              <option value="1month">Past Month</option>
              <option value="1year">Past Year</option>
            </select>
      </div>
      <div class="status">
        <div class="status-item">
          <span class="status-label">MQTT Broker:</span>
          <span class="status-value">StateofCharge</span>
        </div>
        <div class="status-item">
          <span class="status-label">Status:</span>
          <span class="status-value ${connectionStatus === 'Connected' ? 'success' : 'warning'}">
            ${escapeHtml(connectionStatus)}
          </span>
        </div>
      </div>
    </div>
    
      <div class="current-values">
        <div class="value-card weather-card tooltip" data-topic="weather">
          <div class="help-icon" data-tooltip="Current weather conditions affecting solar production. Temperature, humidity, wind speed, cloud cover, and solar radiation intensity.">?</div>
          <div class="tooltip-popup">Current weather conditions affecting solar production. Temperature, humidity, wind speed, cloud cover, and solar radiation intensity.</div>
          <h3>${getWeatherIcon(weatherData.weatherCode)} Weather</h3>
          <div class="value">
            <span class="value-number">${weatherData.temperature}</span>
            <span class="unit">°F</span>
          </div>
          <div class="weather-details">
            <div class="weather-detail">💧 ${weatherData.humidity}%</div>
            <div class="weather-detail">💨 ${weatherData.windSpeed} mph</div>
            <div class="weather-detail">☁️ ${weatherData.cloudCover}%</div>
            <div class="weather-detail">☀️ ${weatherData.solarRadiation} W/m²</div>
          </div>
          <div class="updated">Updated: ${weatherData.lastUpdate ? new Date(weatherData.lastUpdate).toLocaleTimeString() : 'Never'}</div>
        </div>
        
        <div class="value-card pv-power tooltip" data-topic="solar_assistant/inverter_1/pv_power/state">
          <div class="help-icon" data-tooltip="Total power generated by all solar arrays combined. The chart below shows the percentage contribution of each array to the total output. This helps identify performance differences between arrays due to shading, orientation, or panel condition.">?</div>
          <div class="tooltip-popup">Total power generated by all solar arrays combined. The chart below shows the percentage contribution of each array to the total output. This helps identify performance differences between arrays due to shading, orientation, or panel condition.</div>
          <h3>☀️ Total Solar Power</h3>
          <div class="value">
            <span class="value-number">${getCurrentValue('solar_assistant/inverter_1/pv_power/state')}</span>
            <span class="unit">W</span>
          </div>
          <div class="updated">Updated: ${getUpdateTime('solar_assistant/inverter_1/pv_power/state')}</div>
        <div class="solar-array-chart">
          <div class="chart-bar" id="solarArrayChart">
            <div class="bar-segment array1" style="width: 0%; background-color: #20b2aa;"></div>
            <div class="bar-segment array2" style="width: 0%; background-color: #8e44ad;"></div>
          </div>
          <div class="chart-tooltip" id="solarArrayTooltip"></div>
        </div>
        </div>
      
      <div class="value-card pv-power tooltip" style="border-left-color: #20b2aa;" data-topic="solar_assistant/inverter_1/pv_power_1/state">
        <div class="help-icon" data-tooltip="Power generated by the first solar array. The progress bar below shows current performance as a percentage of the array's highest output in the past 24 hours. This helps monitor efficiency and identify when arrays are underperforming due to shading, dirt, or other issues.">?</div>
        <div class="tooltip-popup">Power generated by the first solar array. The progress bar below shows current performance as a percentage of the array's highest output in the past 24 hours. This helps monitor efficiency and identify when arrays are underperforming due to shading, dirt, or other issues.</div>
        <h3>☀️ Array 1 Power</h3>
        <div class="value">
          <span class="value-number">${getCurrentValue('solar_assistant/inverter_1/pv_power_1/state')}</span>
          <span class="unit">W</span>
        </div>
        <div class="updated">Updated: ${getUpdateTime('solar_assistant/inverter_1/pv_power_1/state')}</div>
        <div class="array-performance-chart">
          <div class="performance-bar" id="array1PerformanceChart">
            <div class="performance-fill array1" style="width: 0%; background-color: #20b2aa;"></div>
          </div>
          <div class="chart-tooltip" id="array1PerformanceTooltip"></div>
        </div>
      </div>
      
      <div class="value-card pv-power tooltip" style="border-left-color: #8e44ad;" data-topic="solar_assistant/inverter_1/pv_power_2/state">
        <div class="help-icon" data-tooltip="Power generated by the second solar array. The progress bar below shows current performance as a percentage of the array's highest output in the past 24 hours. Compare with Array 1 to identify performance differences due to orientation, shading, panel condition, or maintenance needs.">?</div>
        <div class="tooltip-popup">Power generated by the second solar array. The progress bar below shows current performance as a percentage of the array's highest output in the past 24 hours. Compare with Array 1 to identify performance differences due to orientation, shading, panel condition, or maintenance needs.</div>
        <h3>☀️ Array 2 Power</h3>
        <div class="value">
          <span class="value-number">${getCurrentValue('solar_assistant/inverter_1/pv_power_2/state')}</span>
          <span class="unit">W</span>
        </div>
        <div class="updated">Updated: ${getUpdateTime('solar_assistant/inverter_1/pv_power_2/state')}</div>
        <div class="array-performance-chart">
          <div class="performance-bar" id="array2PerformanceChart">
            <div class="performance-fill array2" style="width: 0%; background-color: #8e44ad;"></div>
          </div>
          <div class="chart-tooltip" id="array2PerformanceTooltip"></div>
        </div>
      </div>
      
      <div class="value-card battery-soc tooltip" data-topic="solar_assistant/total/battery_state_of_charge/state">
        <div class="help-icon" data-tooltip="Battery State of Charge (SOC) percentage. The progress bar shows charge level with color coding: Green (60-100%), Orange (30-59%), Red (0-29%).">?</div>
        <div class="tooltip-popup">Battery State of Charge (SOC) percentage. The progress bar shows charge level with color coding: Green (60-100%), Orange (30-59%), Red (0-29%).</div>
        <h3>🔋 Battery Charge</h3>
        <div class="value">
          <span class="value-number">${getCurrentValue('solar_assistant/total/battery_state_of_charge/state')}</span>
          <span class="unit">%</span>
        </div>
        <div class="updated">Updated: ${getUpdateTime('solar_assistant/total/battery_state_of_charge/state')}</div>
        <div class="array-performance-chart">
          <div class="performance-bar" id="batteryChargeChart">
            <div class="performance-fill battery-charge" style="width: 0%; background-color: #27ae60;"></div>
          </div>
          <div class="chart-tooltip" id="batteryChargeTooltip"></div>
        </div>
      </div>
      
      <div class="value-card load-power tooltip" data-topic="solar_assistant/inverter_1/load_power/state">
        <div class="help-icon" data-tooltip="Total power consumption of all connected loads (appliances, lights, etc.). This is the power your home is currently using.">?</div>
        <div class="tooltip-popup">Total power consumption of all connected loads (appliances, lights, etc.). This is the power your home is currently using.</div>
        <h3>⚡ Load Power</h3>
        <div class="value">
          <span class="value-number">${getCurrentValue('solar_assistant/inverter_1/load_power/state')}</span>
          <span class="unit">W</span>
        </div>
        <div class="updated">Updated: ${getUpdateTime('solar_assistant/inverter_1/load_power/state')}</div>
      </div>
    </div>
    
    <!-- Daily Statistics Section -->
    <div class="current-values" style="margin-top: 15px;">
      <div class="value-card tooltip" style="border-left: 3px solid #9b59b6;" data-topic="daily-energy-produced">
        <div class="help-icon" data-tooltip="Total energy generated by your solar panels today. This is the cumulative energy production since midnight, measured in kilowatt-hours (kWh).">?</div>
        <div class="tooltip-popup">Total energy generated by your solar panels today. This is the cumulative energy production since midnight, measured in kilowatt-hours (kWh).</div>
        <h3>📊 Energy Produced Today</h3>
        <div class="value">
          <span class="value-number" id="energyProduced">${getDailyEnergyProduced()}</span>
          <span class="unit">kWh</span>
        </div>
        <div class="updated" id="energyProducedLabel">Since 8:33 AM (full day from midnight tomorrow)</div>
      </div>
      
      <div class="value-card tooltip" style="border-left: 3px solid #e74c3c;" data-topic="daily-energy-consumed">
        <div class="help-icon" data-tooltip="Total energy consumed by your home today. This includes all appliances, lights, and electrical devices, measured in kilowatt-hours (kWh).">?</div>
        <div class="tooltip-popup">Total energy consumed by your home today. This includes all appliances, lights, and electrical devices, measured in kilowatt-hours (kWh).</div>
        <h3>📉 Energy Consumed Today</h3>
        <div class="value">
          <span class="value-number" id="energyConsumed">${getDailyEnergyConsumed()}</span>
          <span class="unit">kWh</span>
        </div>
        <div class="updated" id="energyConsumedLabel">Since 8:33 AM (full day from midnight tomorrow)</div>
      </div>
      
      <div class="value-card tooltip" style="border-left: 3px solid #16a085;" data-topic="battery-runtime">
        <div class="help-icon" data-tooltip="Estimated time until battery empty based on current power balance (solar + charger - load). Shows 'Indefinite' when power balance is positive, 'Infinite' when balanced, or time remaining when discharging.">?</div>
        <div class="tooltip-popup">Estimated time until battery empty based on current power balance (solar + charger - load). Shows 'Indefinite' when power balance is positive, 'Infinite' when balanced, or time remaining when discharging.</div>
        <h3>⏱️ Battery Runtime</h3>
        <div class="value">
          <span class="value-number" id="batteryRuntime" style="font-size: 20px;">${getBatteryRuntime()}</span>
        </div>
        <div class="updated">At current power balance</div>
      </div>
      
      <div class="value-card tooltip" style="border-left: 3px solid #f39c12;" data-topic="peak-production">
        <div class="help-icon" data-tooltip="Highest solar power output recorded for the selected time period. Updates dynamically when you change the time period filter above.">?</div>
        <div class="tooltip-popup">Highest solar power output recorded for the selected time period. Updates dynamically when you change the time period filter above.</div>
        <h3>🌟 Peak Performance</h3>
        <div class="value">
          <span class="value-number" id="peakProduction" style="font-size: 14px;">--</span>
        </div>
        <div class="updated" id="peakProductionLabel">Select time period</div>
      </div>
      
      <div class="value-card tooltip" style="border-left: 3px solid #9b59b6;" data-topic="solar_assistant/inverter_1/battery_voltage/state">
        <div class="help-icon" data-tooltip="Battery bank voltage measured in volts (V). Higher voltage indicates more charge. Typical range: 48-58V for 48V systems.">?</div>
        <div class="tooltip-popup">Battery bank voltage measured in volts (V). Higher voltage indicates more charge. Typical range: 48-58V for 48V systems.</div>
        <h3>🔋 Battery Voltage</h3>
        <div class="value">
          <span class="value-number">${cachedData['solar_assistant/inverter_1/battery_voltage/state']?.value || 'N/A'}</span>
          <span class="unit">V</span>
        </div>
        <div class="updated">Updated ${cachedData['solar_assistant/inverter_1/battery_voltage/state']?.timestamp ? new Date(cachedData['solar_assistant/inverter_1/battery_voltage/state'].timestamp).toLocaleTimeString() : 'N/A'}</div>
      </div>
      
      <div class="value-card tooltip" id="powerBalanceCard" style="border-left: 3px solid #3498db;">
        <div class="help-icon" data-tooltip="Net power flow: Positive = excess solar power (charging battery), Negative = using battery power. Zero = balanced system.">?</div>
        <div class="tooltip-popup">Net power flow: Positive = excess solar power (charging battery), Negative = using battery power. Zero = balanced system.</div>
        <h3>⚖️ Power Balance</h3>
        <div class="value">
          <span class="value-number" id="powerBalanceValue">${getPowerBalance()}</span>
          <span class="unit">W</span>
        </div>
        <div class="updated" id="powerBalanceStatus">Calculating...</div>
      </div>
    </div>
    
    
    <div class="charts-container">
      <h2 id="trendsTitle" style="margin-bottom: 30px; color: var(--text-primary); font-size: 24px;">📊 Trends</h2>
      
      <div class="chart-wrapper">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
          <h2 id="pvPowerTitle" style="margin: 0;">☀️ Solar Power - Total & Per Array</h2>
          <div style="display: flex; align-items: center; gap: 10px;">
            <label for="solarArraySelector" class="chart-selector-label">View:</label>
            <select id="solarArraySelector" onchange="changeSolarArrayView(this.value)" class="chart-selector">
              <option value="all">All Arrays</option>
              <option value="total">Total Only</option>
              <option value="array1">Array 1 Only</option>
              <option value="array2">Array 2 Only</option>
            </select>
          </div>
        </div>
        <div class="chart-container" id="pvPowerChartContainer" style="display: none;">
          <canvas id="pvPowerChart"></canvas>
        </div>
      </div>
      
      <div class="chart-wrapper">
        <h2 id="batterySocTitle">🔋 Battery State of Charge</h2>
        <div class="chart-container" id="batterySocChartContainer" style="display: none;">
          <canvas id="batterySocChart"></canvas>
        </div>
      </div>
      
      <div class="chart-wrapper">
        <h2 id="loadPowerTitle">⚡ Load Power</h2>
        <div class="chart-container" id="loadPowerChartContainer" style="display: none;">
          <canvas id="loadPowerChart"></canvas>
        </div>
      </div>
    </div>
  </div>
  
  <script>
    // Global chart instances
    let pvPowerChart = null;
    let batterySocChart = null;
    let loadPowerChart = null;
    let lastUpdateTime = null;
    let currentTimeRange = { min: null, max: null };
    
    // Dark Mode Toggle
    function toggleTheme() {
      const currentTheme = document.documentElement.getAttribute('data-theme');
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      const themeBtn = document.querySelector('.theme-toggle-btn');
      
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('theme', newTheme);
      themeBtn.textContent = newTheme === 'dark' ? '☀️' : '🌙';
      
      // Update chart colors when theme changes
      updateChartColors(newTheme);
    }
    
    // Tooltip positioning with boundary detection
    function positionTooltip(event) {
      const helpIcon = event.target;
      const tooltip = helpIcon.nextElementSibling;
      if (!tooltip || !tooltip.classList.contains('tooltip-popup')) return;
      
      // Get viewport dimensions
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      // Get help icon position
      const iconRect = helpIcon.getBoundingClientRect();
      const iconCenterX = iconRect.left + iconRect.width / 2;
      const iconCenterY = iconRect.top + iconRect.height / 2;
      
      // Calculate tooltip dimensions
      const tooltipWidth = viewportWidth <= 768 ? 200 : 250;
      const tooltipHeight = 80; // Estimate
      const halfWidth = tooltipWidth / 2;
      const halfHeight = tooltipHeight / 2;
      
      // Start with tooltip positioned above the icon
      let tooltipX = iconCenterX;
      let tooltipY = iconRect.top - 10; // 10px above the icon
      
      // Adjust horizontal position to stay within bounds
      if (tooltipX + halfWidth > viewportWidth - 20) {
        // Move left to fit
        tooltipX = viewportWidth - halfWidth - 20;
      }
      if (tooltipX - halfWidth < 20) {
        // Move right to fit
        tooltipX = halfWidth + 20;
      }
      
      // Adjust vertical position if needed
      if (tooltipY - halfHeight < 20) {
        // Move below the icon if not enough space above
        tooltipY = iconRect.bottom + 10;
      }
      
      // Apply positioning
      tooltip.style.left = tooltipX + 'px';
      tooltip.style.top = tooltipY + 'px';
      tooltip.style.transform = 'translateX(-50%) translateY(-100%)';
      
      // Mobile adjustments
      if (viewportWidth <= 768) {
        tooltip.style.width = '200px';
        tooltip.style.fontSize = '11px';
        tooltip.style.padding = '6px 10px';
        tooltip.style.lineHeight = '1.2';
      } else {
        tooltip.style.width = '250px';
        tooltip.style.fontSize = '12px';
        tooltip.style.padding = '8px 12px';
        tooltip.style.lineHeight = '1.3';
      }
    }
    
    // Add event listeners for tooltips
    document.addEventListener('DOMContentLoaded', function() {
      const helpIcons = document.querySelectorAll('.help-icon');
      helpIcons.forEach(icon => {
        icon.addEventListener('mouseenter', function(event) {
          const tooltip = this.nextElementSibling;
          if (tooltip && tooltip.classList.contains('tooltip-popup')) {
            tooltip.classList.add('show');
            positionTooltip(event);
          }
        });
        
        icon.addEventListener('mouseleave', function() {
          const tooltip = this.nextElementSibling;
          if (tooltip && tooltip.classList.contains('tooltip-popup')) {
            tooltip.classList.remove('show');
          }
        });
      });
      
      // Add event listeners for chart tooltips
      setTimeout(function() {
        setupChartTooltips();
      }, 1000); // Delay to ensure charts are loaded
    });
    
    // Setup chart tooltip event listeners
    function setupChartTooltips() {
      // Solar array chart tooltips
      const solarArrayChart = document.getElementById('solarArrayChart');
      if (solarArrayChart) {
        const array1Segment = solarArrayChart.querySelector('.array1');
        const array2Segment = solarArrayChart.querySelector('.array2');
        const tooltip = document.getElementById('solarArrayTooltip');
        
        if (array1Segment && tooltip) {
          array1Segment.addEventListener('mouseenter', function(event) {
            const power = this.getAttribute('data-power') || '0';
            const percentage = this.getAttribute('data-percentage') || '0';
            tooltip.textContent = 'Array 1: ' + power + 'W (' + percentage + '% of total)';
            positionChartTooltip(event, tooltip);
            tooltip.classList.add('show');
          });
          
          array1Segment.addEventListener('mouseleave', function() {
            tooltip.classList.remove('show');
          });
        }
        
        if (array2Segment && tooltip) {
          array2Segment.addEventListener('mouseenter', function(event) {
            const power = this.getAttribute('data-power') || '0';
            const percentage = this.getAttribute('data-percentage') || '0';
            tooltip.textContent = 'Array 2: ' + power + 'W (' + percentage + '% of total)';
            positionChartTooltip(event, tooltip);
            tooltip.classList.add('show');
          });
          
          array2Segment.addEventListener('mouseleave', function() {
            tooltip.classList.remove('show');
          });
        }
      }
      
      // Array 1 performance chart tooltip
      const array1Chart = document.getElementById('array1PerformanceChart');
      if (array1Chart) {
        const array1Fill = array1Chart.querySelector('.array1');
        const tooltip = document.getElementById('array1PerformanceTooltip');
        
        if (array1Fill && tooltip) {
          array1Fill.addEventListener('mouseenter', function(event) {
            const power = this.getAttribute('data-power') || '0';
            const percentage = this.getAttribute('data-percentage') || '0';
            const peak = this.getAttribute('data-peak') || '0';
            tooltip.textContent = 'Current: ' + power + 'W (' + percentage + '% of 24h peak: ' + peak + 'W)';
            positionChartTooltip(event, tooltip);
            tooltip.classList.add('show');
          });
          
          array1Fill.addEventListener('mouseleave', function() {
            tooltip.classList.remove('show');
          });
        }
      }
      
      // Array 2 performance chart tooltip
      const array2Chart = document.getElementById('array2PerformanceChart');
      if (array2Chart) {
        const array2Fill = array2Chart.querySelector('.array2');
        const tooltip = document.getElementById('array2PerformanceTooltip');
        
        if (array2Fill && tooltip) {
          array2Fill.addEventListener('mouseenter', function(event) {
            const power = this.getAttribute('data-power') || '0';
            const percentage = this.getAttribute('data-percentage') || '0';
            const peak = this.getAttribute('data-peak') || '0';
            tooltip.textContent = 'Current: ' + power + 'W (' + percentage + '% of 24h peak: ' + peak + 'W)';
            positionChartTooltip(event, tooltip);
            tooltip.classList.add('show');
          });
          
          array2Fill.addEventListener('mouseleave', function() {
            tooltip.classList.remove('show');
          });
        }
      }
    }
    
    // Position chart tooltip
    function positionChartTooltip(event, tooltip) {
      const rect = event.target.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      
      let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
      let top = rect.top - tooltipRect.height - 10;
      
      // Keep tooltip within viewport
      if (left < 10) left = 10;
      if (left + tooltipRect.width > window.innerWidth - 10) {
        left = window.innerWidth - tooltipRect.width - 10;
      }
      if (top < 10) {
        top = rect.bottom + 10;
      }
      
      tooltip.style.left = left + 'px';
      tooltip.style.top = top + 'px';
    }
    
    
    // Logout Function
    async function logout() {
      if (confirm('Are you sure you want to logout?')) {
        try {
          const response = await fetch('/api/auth/logout', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            }
          });
          
          if (response.ok) {
            window.location.href = '/login';
          } else {
            alert('Logout failed. Please try again.');
          }
        } catch (error) {
          console.error('Logout error:', error);
          alert('Network error. Please try again.');
        }
      }
    }
    
    // Load theme from localStorage on page load
    function loadTheme() {
      const savedTheme = localStorage.getItem('theme') || 'light';
      const themeBtn = document.querySelector('.theme-toggle-btn');
      
      document.documentElement.setAttribute('data-theme', savedTheme);
      if (themeBtn) {
        themeBtn.textContent = savedTheme === 'dark' ? '☀️' : '🌙';
      }
    }
    
    // Update chart colors based on theme
    function updateChartColors(theme) {
      const textColor = theme === 'dark' ? '#f0f0f0' : '#333';
      const gridColor = theme === 'dark' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)';
      
      [pvPowerChart, batterySocChart, loadPowerChart].forEach(chart => {
        if (chart) {
          chart.options.scales.x.ticks.color = textColor;
          chart.options.scales.x.title.color = textColor;
          chart.options.scales.y.ticks.color = textColor;
          chart.options.scales.y.title.color = textColor;
          chart.options.scales.x.grid.color = gridColor;
          chart.options.scales.y.grid.color = gridColor;
          chart.update('none');
        }
      });
      
    }
    
    // Initialize drag and drop for value cards
    function initDragAndDrop() {
      const containers = document.querySelectorAll('.current-values');
      containers.forEach(container => {
        new Sortable(container, {
          animation: 150,
          ghostClass: 'sortable-ghost',
          dragClass: 'sortable-drag',
          handle: '.value-card',
          onEnd: function() {
            // Save layout to localStorage
            saveLayout(container);
          }
        });
        
        // Load saved layout
        loadLayout(container);
      });
    }
    
    // Save layout to localStorage
    function saveLayout(container) {
      const cards = container.querySelectorAll('.value-card');
      const layout = Array.from(cards).map(card => card.getAttribute('data-topic'));
      const containerId = container.closest('.current-values') === document.querySelectorAll('.current-values')[0] ? 'main' : 'stats';
      localStorage.setItem('dashboard-layout-' + containerId, JSON.stringify(layout));
    }
    
    // Load layout from localStorage
    function loadLayout(container) {
      const containerId = container.closest('.current-values') === document.querySelectorAll('.current-values')[0] ? 'main' : 'stats';
      const savedLayout = localStorage.getItem('dashboard-layout-' + containerId);
      
      if (savedLayout) {
        try {
          const layout = JSON.parse(savedLayout);
          const cards = Array.from(container.querySelectorAll('.value-card'));
          
          layout.forEach((topic, index) => {
            const card = cards.find(c => c.getAttribute('data-topic') === topic);
            if (card) {
              container.appendChild(card);
            }
          });
        } catch (e) {
          console.error('Error loading layout:', e);
        }
      }
    }
    
    
    
    
    // Load theme on page load
    loadTheme();
    
    // Fetch historical data and create charts
    fetch('/data/history')
      .then(response => response.json())
      .then(historyData => {
        const data = historyData.data;
        
        // Historical data is loaded and available for chart creation when time period is selected
        
        // Charts will be created only when user selects a time period
        console.log('Historical data loaded - charts will be created when time period is selected');

        
        // Initialize drag and drop
        initDragAndDrop();
        
        // Load initial current data for power balance
        fetch('/data')
          .then(response => response.json())
          .then(currentData => {
            updatePowerBalance(currentData.data);
            updateSolarArrayChart(currentData.data);
            updateArrayPerformanceCharts(currentData.data);
          })
          .catch(error => console.error('Error loading initial data:', error));
        
        // Start polling for updates
        startPolling();
      })
      .catch(error => {
        console.error('Error loading historical data:', error);
      });
    
    // Poll for new data every 3 seconds for real-time display
    function startPolling() {
      // Update data every 3 seconds for real-time display
      setInterval(updateData, 3000);
    }
    
    // Update data without page refresh
    function updateData() {
      fetch('/data')
        .then(response => response.json())
        .then(currentData => {
          const data = currentData.data;
          const timestamp = new Date();
          
          // Update value cards
          updateValueCard('solar_assistant/inverter_1/pv_power/state', data);
          updateValueCard('solar_assistant/inverter_1/pv_power_1/state', data);
          updateValueCard('solar_assistant/inverter_1/pv_power_2/state', data);
          updateValueCard('solar_assistant/total/battery_state_of_charge/state', data);
          updateBatteryStatusChart(data['solar_assistant/total/battery_state_of_charge/state']);
          updateValueCard('solar_assistant/total/battery_power/state', data);
          updateValueCard('solar_assistant/inverter_1/load_power/state', data);
          updateValueCard('solar_assistant/inverter_1/battery_voltage/state', data);
          
          // Store charger state globally for power balance calculation
          if (currentData.chargerState) {
            window.chargerState = currentData.chargerState;
          }
          
          updatePowerBalance(data);
          
          // Update solar array chart
          updateSolarArrayChart(data);
          
          // Update array performance charts
          updateArrayPerformanceCharts(data);
          
          // Update weather card
          if (currentData.weather) {
            updateWeatherCard(currentData.weather);
          }
          
          // Update daily statistics
          updateDailyStatsDisplay();
          
          
          // Add new data points to charts (only add if significantly different time)
          if (!lastUpdateTime || (timestamp - lastUpdateTime) >= 5000) {
            addDataPointToChart(pvPowerChart, 0, 'solar_assistant/inverter_1/pv_power/state', data, timestamp);
            addDataPointToChart(pvPowerChart, 1, 'solar_assistant/inverter_1/pv_power_1/state', data, timestamp);
            addDataPointToChart(pvPowerChart, 2, 'solar_assistant/inverter_1/pv_power_2/state', data, timestamp);
            addDataPointToChart(batterySocChart, 0, 'solar_assistant/total/battery_state_of_charge/state', data, timestamp);
            addDataPointToChart(loadPowerChart, 0, 'solar_assistant/inverter_1/load_power/state', data, timestamp);
            lastUpdateTime = timestamp;
          }
        })
        .catch(error => {
          console.error('Error updating data:', error);
        });
    }
    
    // Helper function to update daily statistics display
    function updateDailyStatsDisplay() {
      fetch('/data/daily-stats')
        .then(response => response.json())
        .then(stats => {
          const energyProducedEl = document.getElementById('energyProduced');
          const energyConsumedEl = document.getElementById('energyConsumed');
          const batteryRuntimeEl = document.getElementById('batteryRuntime');
          const peakProductionEl = document.getElementById('peakProduction');
          const energyProducedLabelEl = document.getElementById('energyProducedLabel');
          const energyConsumedLabelEl = document.getElementById('energyConsumedLabel');
          
          if (energyProducedEl) energyProducedEl.textContent = stats.energyProduced;
          if (energyConsumedEl) energyConsumedEl.textContent = stats.energyConsumed;
          if (batteryRuntimeEl) batteryRuntimeEl.textContent = stats.batteryRuntime;
          // Note: peakPerformance is updated only when time period changes, not during 3-second refresh
          
          // Update labels with tracking start time
          const label = stats.trackingStartTime === 'Just started' ? 'Initializing...' : 'Since ' + stats.trackingStartTime;
          if (energyProducedLabelEl) energyProducedLabelEl.textContent = label;
          if (energyConsumedLabelEl) energyConsumedLabelEl.textContent = label;
        })
        .catch(error => console.error('Error updating daily stats:', error));
    }
    
    // Helper function to update weather card
    function updateWeatherCard(weather) {
      const card = document.querySelector('[data-topic="weather"]');
      if (card) {
        const valueNumber = card.querySelector('.value-number');
        const updatedDiv = card.querySelector('.updated');
        const titleElement = card.querySelector('h3');
        const weatherDetails = card.querySelectorAll('.weather-detail');

        if (valueNumber) {
          valueNumber.textContent = weather.temperature;
        }
        if (updatedDiv) {
          updatedDiv.textContent = 'Updated: ' + (weather.lastUpdate ? new Date(weather.lastUpdate).toLocaleTimeString() : 'Never');
        }
        if (titleElement) {
          // Get weather icon based on weather code
          const iconMap = {
            0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️', 45: '🌫️', 48: '🌫️',
            51: '🌦️', 53: '🌦️', 55: '🌧️', 61: '🌧️', 63: '🌧️', 65: '🌧️',
            71: '🌨️', 73: '🌨️', 75: '🌨️', 77: '🌨️', 80: '🌦️', 81: '🌧️',
            82: '🌧️', 85: '🌨️', 86: '🌨️', 95: '⛈️', 96: '⛈️', 99: '⛈️'
          };
          const icon = iconMap[weather.weatherCode] || '🌤️';
          titleElement.textContent = icon + ' Weather';
        }
        
        // Update weather details
        if (weatherDetails.length >= 4) {
          weatherDetails[0].textContent = '💧 ' + weather.humidity + '%';
          weatherDetails[1].textContent = '💨 ' + weather.windSpeed + ' mph';
          weatherDetails[2].textContent = '☁️ ' + weather.cloudCover + '%';
          weatherDetails[3].textContent = '☀️ ' + weather.solarRadiation + ' W/m²';
        }
      }
    }

    // Helper function to update value cards
    function updateValueCard(topic, data) {
      if (data[topic] && data[topic].value !== null && data[topic].value !== undefined) {
        const value = parseFloat(data[topic].value);
        if (!isNaN(value)) {
          // Find the card by data-topic attribute
          const card = document.querySelector('[data-topic="' + topic + '"]');
          if (card) {
            const valueNumber = card.querySelector('.value-number');
            const updatedDiv = card.querySelector('.updated');
            
            if (valueNumber) {
              valueNumber.textContent = Math.round(value);
            }
            if (updatedDiv) {
              updatedDiv.textContent = 'Updated: ' + new Date(data[topic].timestamp).toLocaleTimeString();
            }
          }
        }
      }
    }
    
    // Helper function to update battery charge bar chart
    function updateBatteryStatusChart(batteryData) {
      if (!batteryData || batteryData.value === null || batteryData.value === undefined) {
        return;
      }
      
      const soc = parseFloat(batteryData.value);
      if (isNaN(soc)) {
        return;
      }
      
      const batteryChart = document.getElementById('batteryChargeChart');
      if (!batteryChart) {
        return;
      }
      
      const batteryFill = batteryChart.querySelector('.battery-charge');
      if (!batteryFill) {
        return;
      }
      
      // Set the width to the SOC percentage
      batteryFill.style.width = soc + '%';
      
      // Determine color based on SOC range: 100%-60% success, 30%-59% warning, 0%-29% danger
      let color;
      if (soc >= 60) {
        color = '#27ae60'; // Success color (green)
      } else if (soc >= 30) {
        color = '#f39c12'; // Warning color (orange/yellow)
      } else {
        color = '#e74c3c'; // Danger color (red)
      }
      
      batteryFill.style.backgroundColor = color;
      
      // Store data for tooltips
      batteryFill.setAttribute('data-soc', soc);
      batteryFill.setAttribute('data-color', color);
      
      console.log('Updated battery charge bar to', soc + '% with color', color);
    }
    
    // Helper function to update power balance card with dynamic colors and arrows
    function updatePowerBalance(data) {
      const solarTopic = 'solar_assistant/inverter_1/pv_power/state';
      const loadTopic = 'solar_assistant/inverter_1/load_power/state';
      const batteryPowerTopic = 'solar_assistant/total/battery_power/state';
      
      if (data[solarTopic] && data[loadTopic]) {
        const solarPower = parseFloat(data[solarTopic].value);
        const loadPower = parseFloat(data[loadTopic].value);
        const batteryPower = data[batteryPowerTopic] ? parseFloat(data[batteryPowerTopic].value) : 0;
        
        if (!isNaN(solarPower) && !isNaN(loadPower)) {
          // Calculate total power input: Solar + External Charger (if IFTTT triggered ON)
          const isExternalChargerOn = window.chargerState && window.chargerState.isOn;
          const externalChargerPower = (isExternalChargerOn && batteryPower > 0) ? batteryPower : 0;
          const totalPowerInput = solarPower + externalChargerPower;
          const balance = totalPowerInput - loadPower;
          
          const card = document.getElementById('powerBalanceCard');
          const valueElement = document.getElementById('powerBalanceValue');
          const statusElement = document.getElementById('powerBalanceStatus');
          
          if (card && valueElement && statusElement) {
            // Update the value
            const absBalance = Math.abs(Math.round(balance));
            
            if (balance > 0) {
              // Net positive - green with up arrow
              valueElement.innerHTML = '↑ ' + absBalance;
              valueElement.style.color = '#27ae60';
              card.style.borderLeft = '3px solid #27ae60';
              
              // Simple status: show charger details only when IFTTT charger is active
              if (isExternalChargerOn && externalChargerPower > 0) {
                let statusText = '🔋 Charging';
                statusText += '<br><span style="font-size: 11px; color: var(--text-muted);">⚡ Charger: ' + Math.round(externalChargerPower) + 'W</span>';
                statusElement.innerHTML = statusText;
              } else {
                statusElement.textContent = '🔋 Charging';
              }
              statusElement.style.color = '#27ae60';
            } else if (balance < 0) {
              // Net negative - red with down arrow
              valueElement.innerHTML = '↓ ' + absBalance;
              valueElement.style.color = '#e74c3c';
              card.style.borderLeft = '3px solid #e74c3c';
              statusElement.textContent = '⚡ Discharging';
              statusElement.style.color = '#e74c3c';
            } else {
              // Balanced - blue
              valueElement.innerHTML = '— ' + absBalance;
              valueElement.style.color = '#3498db'; // Blue
              card.style.borderLeft = '3px solid #3498db';
              statusElement.textContent = '⚖️ Balanced';
              statusElement.style.color = '#3498db';
            }
          }
        }
      }
    }
    
    // Helper function to update solar array chart
    function updateSolarArrayChart(data) {
      const array1Topic = 'solar_assistant/inverter_1/pv_power_1/state';
      const array2Topic = 'solar_assistant/inverter_1/pv_power_2/state';
      
      console.log('Updating solar array chart with data:', data);
      
      if (data[array1Topic] && data[array2Topic]) {
        const array1Power = parseFloat(data[array1Topic].value) || 0;
        const array2Power = parseFloat(data[array2Topic].value) || 0;
        const totalPower = array1Power + array2Power;
        
        console.log('Array powers - Array1:', array1Power, 'Array2:', array2Power, 'Total:', totalPower);
        
        const chart = document.getElementById('solarArrayChart');
        console.log('Chart element found:', chart);
        
        if (chart) {
          const array1Segment = chart.querySelector('.array1');
          const array2Segment = chart.querySelector('.array2');
          
          console.log('Array segments found - Array1:', array1Segment, 'Array2:', array2Segment);
          
          if (array1Segment && array2Segment) {
            if (totalPower === 0) {
              array1Segment.style.width = '0%';
              array2Segment.style.width = '0%';
              console.log('Set both arrays to 0% width');
            } else {
              const array1Percentage = Math.round((array1Power / totalPower) * 100);
              const array2Percentage = Math.round((array2Power / totalPower) * 100);
              
              array1Segment.style.width = array1Percentage + '%';
              array2Segment.style.width = array2Percentage + '%';
              console.log('Updated array widths - Array1:', array1Percentage + '%', 'Array2:', array2Percentage + '%');
              
              // Store data for tooltips
              array1Segment.setAttribute('data-power', array1Power);
              array1Segment.setAttribute('data-percentage', array1Percentage);
              array2Segment.setAttribute('data-power', array2Power);
              array2Segment.setAttribute('data-percentage', array2Percentage);
            }
          }
        }
      } else {
        console.log('Missing array data - Array1 topic:', data[array1Topic], 'Array2 topic:', data[array2Topic]);
      }
    }
    
    // Helper function to update array performance charts
    function updateArrayPerformanceCharts(data) {
      const array1Topic = 'solar_assistant/inverter_1/pv_power_1/state';
      const array2Topic = 'solar_assistant/inverter_1/pv_power_2/state';
      
      console.log('Updating array performance charts with data:', data);
      
      // Update Array 1 performance chart
      if (data[array1Topic]) {
        const array1Power = parseFloat(data[array1Topic].value) || 0;
        
        // For now, use a simple fallback calculation
        // TODO: Implement proper 24-hour peak calculation with historical data
        const array1Peak = Math.max(array1Power * 2, 1000); // Fallback: assume peak is at least 2x current or 1000W
        const array1Percentage = array1Peak > 0 ? Math.round((array1Power / array1Peak) * 100) : 0;
        
        console.log('Array 1 - Current:', array1Power, 'Peak (fallback):', array1Peak, 'Percentage:', array1Percentage + '%');
        
        const array1Chart = document.getElementById('array1PerformanceChart');
        if (array1Chart) {
          const array1Fill = array1Chart.querySelector('.array1');
          if (array1Fill) {
            array1Fill.style.width = array1Percentage + '%';
            console.log('Updated Array 1 performance bar to', array1Percentage + '%');
            
            // Store data for tooltips
            array1Fill.setAttribute('data-power', array1Power);
            array1Fill.setAttribute('data-percentage', array1Percentage);
            array1Fill.setAttribute('data-peak', array1Peak);
          }
        }
      }
      
      // Update Array 2 performance chart
      if (data[array2Topic]) {
        const array2Power = parseFloat(data[array2Topic].value) || 0;
        
        // For now, use a simple fallback calculation
        // TODO: Implement proper 24-hour peak calculation with historical data
        const array2Peak = Math.max(array2Power * 2, 1000); // Fallback: assume peak is at least 2x current or 1000W
        const array2Percentage = array2Peak > 0 ? Math.round((array2Power / array2Peak) * 100) : 0;
        
        console.log('Array 2 - Current:', array2Power, 'Peak (fallback):', array2Peak, 'Percentage:', array2Percentage + '%');
        
        const array2Chart = document.getElementById('array2PerformanceChart');
        if (array2Chart) {
          const array2Fill = array2Chart.querySelector('.array2');
          if (array2Fill) {
            array2Fill.style.width = array2Percentage + '%';
            console.log('Updated Array 2 performance bar to', array2Percentage + '%');
            
            // Store data for tooltips
            array2Fill.setAttribute('data-power', array2Power);
            array2Fill.setAttribute('data-percentage', array2Percentage);
            array2Fill.setAttribute('data-peak', array2Peak);
          }
        }
      }
    }
    
    // Helper function to add data point to chart
    function addDataPointToChart(chart, datasetIndex, topic, data, timestamp) {
      if (chart && chart.data.datasets[datasetIndex] && data[topic]) {
        const value = parseFloat(data[topic].value);
        if (!isNaN(value)) {
          const newDataPoint = {
            x: timestamp,
            y: value
          };
          
          // Only add data point if it falls within the current time range
          if (currentTimeRange.min && currentTimeRange.max) {
            if (timestamp >= currentTimeRange.min && timestamp <= currentTimeRange.max) {
              chart.data.datasets[datasetIndex].data.push(newDataPoint);
              
              // Keep only last 2000 data points to prevent memory issues
              if (chart.data.datasets[datasetIndex].data.length > 2000) {
                chart.data.datasets[datasetIndex].data.shift();
              }
              
              chart.update('none'); // 'none' mode for no animation = smoother updates
            }
          } else {
            // If no time range is set, add all data points (initial load)
            chart.data.datasets[datasetIndex].data.push(newDataPoint);
            
            // Keep only last 2000 data points to prevent memory issues
            if (chart.data.datasets[datasetIndex].data.length > 2000) {
              chart.data.datasets[datasetIndex].data.shift();
            }
            
            chart.update('none'); // 'none' mode for no animation = smoother updates
          }
        }
      }
    }
    
    // Function to create charts with a specific time period
    function createChartsWithPeriod(period) {
      const now = new Date();
      let startTime;
      
      switch(period) {
        case '1hour':
          startTime = new Date(now.getTime() - 60 * 60 * 1000);
          break;
        case '12hours':
          startTime = new Date(now.getTime() - 12 * 60 * 60 * 1000);
          break;
        case '24hours':
          startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;
        case '48hours':
          startTime = new Date(now.getTime() - 48 * 60 * 60 * 1000);
          break;
        case '7days':
          startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '1month':
          startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        case '1year':
          startTime = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
          break;
        default:
          startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      }
      
      // Update time unit and display formats based on period
      let timeUnit = 'hour';
      let maxTicks = 8;
      let displayFormats = {
        minute: 'h:mm a',
        hour: 'h:mm a',
        day: 'MMM d'
      };
      
      switch(period) {
        case '1hour':
          timeUnit = 'minute';
          maxTicks = 6;
          displayFormats.minute = 'h:mm a';
          break;
        case '12hours':
          timeUnit = 'hour';
          maxTicks = 6;
          break;
        case '24hours':
          timeUnit = 'hour';
          maxTicks = 8;
          break;
        case '48hours':
          timeUnit = 'hour';
          maxTicks = 12;
          break;
        case '7days':
          timeUnit = 'day';
          maxTicks = 7;
          break;
        case '1month':
          timeUnit = 'day';
          maxTicks = 15;
          break;
        case '1year':
          timeUnit = 'month';
          maxTicks = 12;
          break;
      }
      
      // Fetch historical data and create charts with filtered data
      fetch('/data/history')
        .then(response => response.json())
        .then(historyData => {
          const data = historyData.data;
          
          // Data filtering and reduction function
          function filterAndReduce(topicData, maxPoints = 100) {
            if (!topicData || topicData.length === 0) return [];
            
            // Filter to time range first
            const filtered = topicData.filter(item => {
              const itemTime = new Date(item.timestamp);
              return itemTime >= startTime && itemTime <= now;
            });
            
            // Then reduce points if needed
            if (filtered.length <= maxPoints) return filtered.map(item => ({
              x: new Date(item.timestamp),
              y: item.value
            }));
            
            const step = Math.ceil(filtered.length / maxPoints);
            const reduced = [];
            for (let i = 0; i < filtered.length; i += step) {
              const slice = filtered.slice(i, i + step);
              const avgX = slice.reduce((sum, point) => sum + new Date(point.timestamp).getTime(), 0) / slice.length;
              const avgY = slice.reduce((sum, point) => sum + point.value, 0) / slice.length;
              reduced.push({ x: new Date(avgX), y: avgY });
            }
            return reduced;
          }

          // Common chart options with time range set
          const commonOptions = {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
              intersect: false,
              mode: 'index'
            },
            plugins: {
              legend: {
                display: false
              },
              tooltip: {
                mode: 'index',
                intersect: false,
                callbacks: {
                  title: function(context) {
                    const date = new Date(context[0].parsed.x);
                    return date.toLocaleString();
                  }
                }
              }
            },
            scales: {
              x: {
                type: 'time',
                min: startTime,
                max: now,
                time: {
                  unit: timeUnit,
                  displayFormats: displayFormats,
                  tooltipFormat: 'MMM d, yyyy h:mm a'
                },
                title: {
                  display: true,
                  text: 'Time',
                  font: {
                    size: 14,
                    weight: 'bold'
                  }
                },
                ticks: {
                  maxRotation: 45,
                  minRotation: 0,
                  autoSkip: true,
                  maxTicksLimit: maxTicks,
                  font: {
                    size: 12
                  }
                },
                grid: {
                  display: true,
                  color: 'rgba(0, 0, 0, 0.1)'
                }
              },
              y: {
                beginAtZero: true,
                ticks: {
                  font: {
                    size: 12
                  }
                },
                grid: {
                  color: 'rgba(0, 0, 0, 0.1)'
                }
              }
            }
          };
          
          // Create PV Power Chart
          const datasets = [];
          
          if (data['solar_assistant/inverter_1/pv_power/state']) {
            const pvTotalData = filterAndReduce(data['solar_assistant/inverter_1/pv_power/state'], 100);
            datasets.push({
              label: 'Total Solar Power (W)',
              data: pvTotalData,
              borderColor: '#f39c12',
              backgroundColor: 'rgba(243, 156, 18, 0.1)',
              fill: true,
              tension: 0.3,
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 4,
              spanGaps: true
            });
          }
          
          if (data['solar_assistant/inverter_1/pv_power_1/state']) {
            const pv1Data = filterAndReduce(data['solar_assistant/inverter_1/pv_power_1/state'], 80);
            datasets.push({
              label: 'Array 1 Power (W)',
              data: pv1Data,
              borderColor: '#20b2aa',
              backgroundColor: 'rgba(32, 178, 170, 0.1)',
              fill: false,
              tension: 0.3,
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 3,
              spanGaps: true
            });
          }
          
          if (data['solar_assistant/inverter_1/pv_power_2/state']) {
            const pv2Data = filterAndReduce(data['solar_assistant/inverter_1/pv_power_2/state'], 80);
            datasets.push({
              label: 'Array 2 Power (W)',
              data: pv2Data,
              borderColor: '#8e44ad',
              backgroundColor: 'rgba(142, 68, 173, 0.1)',
              fill: false,
              tension: 0.3,
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 3,
              spanGaps: true
            });
          }
          
          if (datasets.length > 0) {
            pvPowerChart = new Chart(document.getElementById('pvPowerChart'), {
              type: 'line',
              data: {
                datasets: datasets
              },
              options: {
                ...commonOptions,
                plugins: {
                  ...commonOptions.plugins,
                  legend: {
                    display: true,
                    position: 'top',
                    labels: {
                      color: getComputedStyle(document.documentElement).getPropertyValue('--text-primary') || '#333',
                      usePointStyle: true,
                      pointStyle: 'line',
                      padding: 15,
                      font: {
                        size: 12,
                        weight: 'bold'
                      }
                    }
                  }
                },
                scales: {
                  ...commonOptions.scales,
                  y: {
                    ...commonOptions.scales.y,
                    title: {
                      display: true,
                      text: 'Power (W)'
                    }
                  }
                }
              }
            });
          }
          
          // Create Battery SOC Chart
          if (data['solar_assistant/total/battery_state_of_charge/state']) {
            const socData = filterAndReduce(data['solar_assistant/total/battery_state_of_charge/state'], 100);
            
            batterySocChart = new Chart(document.getElementById('batterySocChart'), {
              type: 'line',
              data: {
                datasets: [{
                  label: 'Battery SOC (%)',
                  data: socData,
                  borderColor: '#27ae60',
                  backgroundColor: 'rgba(39, 174, 96, 0.1)',
                  fill: true,
                  tension: 0.3,
                  borderWidth: 2,
                  pointRadius: 0,
                  pointHoverRadius: 4,
                  spanGaps: true
                }]
              },
              options: {
                ...commonOptions,
                scales: {
                  ...commonOptions.scales,
                  y: {
                    beginAtZero: true,
                    max: 100,
                    title: {
                      display: true,
                      text: 'State of Charge (%)'
                    }
                  }
                }
              }
            });
          }
          
          // Create Load Power Chart
          if (data['solar_assistant/inverter_1/load_power/state']) {
            const loadData = filterAndReduce(data['solar_assistant/inverter_1/load_power/state'], 100);
            
            loadPowerChart = new Chart(document.getElementById('loadPowerChart'), {
              type: 'line',
              data: {
                datasets: [{
                  label: 'Load Power (W)',
                  data: loadData,
                  borderColor: '#3498db',
                  backgroundColor: 'rgba(52, 152, 219, 0.1)',
                  fill: true,
                  tension: 0.3,
                  borderWidth: 2,
                  pointRadius: 0,
                  pointHoverRadius: 4,
                  spanGaps: true
                }]
              },
              options: {
                ...commonOptions,
                scales: {
                  ...commonOptions.scales,
                  y: {
                    ...commonOptions.scales.y,
                    title: {
                      display: true,
                      text: 'Power (W)'
                    }
                  }
                }
              }
            });
          }
          
          // Update chart titles and show charts
          const periodLabels = {
            '1hour': 'Past 1 Hour',
            '12hours': 'Past 12 Hours',
            '24hours': 'Past 24 Hours',
            '48hours': 'Past 48 Hours',
            '7days': 'Past 7 Days',
            '1month': 'Past Month',
            '1year': 'Past Year'
          };
          
          const periodLabel = periodLabels[period] || 'Past 1 Hour';
          const pvPowerTitle = document.getElementById('pvPowerTitle');
          const batterySocTitle = document.getElementById('batterySocTitle');
          const loadPowerTitle = document.getElementById('loadPowerTitle');
          
          if (pvPowerTitle) pvPowerTitle.textContent = '☀️ Solar Power - Total & Per Array (' + periodLabel + ')';
          if (batterySocTitle) batterySocTitle.textContent = '🔋 Battery State of Charge (' + periodLabel + ')';
          if (loadPowerTitle) loadPowerTitle.textContent = '⚡ Load Power (' + periodLabel + ')';
          
          // Show the charts
          const pvContainer = document.getElementById('pvPowerChartContainer');
          const batteryContainer = document.getElementById('batterySocChartContainer');
          const loadContainer = document.getElementById('loadPowerChartContainer');
          
          if (pvContainer) pvContainer.style.display = 'block';
          if (batteryContainer) batteryContainer.style.display = 'block';
          if (loadContainer) loadContainer.style.display = 'block';
          
          // Update peak performance for the selected time period
          updatePeakPerformance(period);
          
          console.log('Charts created successfully with period:', period, 'Time range:', startTime, 'to', now);
        })
        .catch(error => {
          console.error('Error creating charts with period:', error);
        });
    }

    // Function to change time period for charts
    function changeTimePeriod(period) {
      // Handle empty selection - don't show charts yet
      if (!period || period === '') {
        console.log('No time period selected - charts will remain hidden until selection is made');
        return;
      }
      
      const now = new Date();
      let startTime;
      
      // If charts don't exist yet, create them first
      if (!pvPowerChart || !batterySocChart || !loadPowerChart) {
        console.log('Creating charts for first time with period:', period);
        createChartsWithPeriod(period);
        return;
      }
      
      switch(period) {
        case '1hour':
          startTime = new Date(now.getTime() - 60 * 60 * 1000);
          break;
        case '12hours':
          startTime = new Date(now.getTime() - 12 * 60 * 60 * 1000);
          break;
        case '24hours':
          startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;
        case '48hours':
          startTime = new Date(now.getTime() - 48 * 60 * 60 * 1000);
          break;
        case '7days':
          startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '1month':
          startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        case '1year':
          startTime = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
          break;
        default:
          startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      }
      
      // Update time unit and display formats based on period
      let timeUnit = 'hour';
      let maxTicks = 8;
      let displayFormats = {
        minute: 'h:mm a',
        hour: 'MMM d, h a',
        day: 'MMM d'
      };
      
      if (period === '1hour') {
        timeUnit = 'minute';
        maxTicks = 6;
        displayFormats = {
          minute: 'h:mm a',
          hour: 'h:mm a',
          day: 'MMM d'
        };
      } else if (period === '12hours' || period === '24hours') {
        timeUnit = 'hour';
        maxTicks = 12;
        displayFormats = {
          minute: 'h:mm a',
          hour: 'h a',
          day: 'MMM d'
        };
      } else if (period === '48hours') {
        timeUnit = 'hour';
        maxTicks = 16;
        displayFormats = {
          minute: 'h:mm a',
          hour: 'MMM d, h a',
          day: 'MMM d'
        };
      } else if (period === '7days') {
        timeUnit = 'day';
        maxTicks = 7;
        displayFormats = {
          minute: 'h:mm a',
          hour: 'MMM d, h a',
          day: 'MMM d'
        };
      } else if (period === '1month') {
        timeUnit = 'day';
        maxTicks = 15;
        displayFormats = {
          minute: 'h:mm a',
          hour: 'MMM d, h a',
          day: 'MMM d'
        };
      } else if (period === '1year') {
        timeUnit = 'month';
        maxTicks = 12;
        displayFormats = {
          minute: 'h:mm a',
          hour: 'MMM d, h a',
          day: 'MMM d',
          month: 'MMM yyyy'
        };
      }
      
      // Update global time range for new data filtering
      currentTimeRange.min = startTime;
      currentTimeRange.max = now;
      
      // Re-fetch historical data from server to get full dataset for selected time range
      fetch('/data/history')
        .then(response => response.json())
        .then(historyData => {
          const data = historyData.data;
          
          // Helper function to filter and reduce data
          function filterAndReduce(topicData, maxPoints) {
            if (!topicData) return [];
            
            // Filter to time range first
            const filtered = topicData.filter(item => {
              const itemTime = new Date(item.timestamp);
              return itemTime >= startTime && itemTime <= now;
            });
            
            // Then reduce points if needed
            if (filtered.length <= maxPoints) return filtered.map(item => ({
              x: new Date(item.timestamp),
              y: item.value
            }));
            
            const step = Math.ceil(filtered.length / maxPoints);
            const reduced = [];
            for (let i = 0; i < filtered.length; i += step) {
              const slice = filtered.slice(i, i + step);
              const avgX = slice.reduce((sum, point) => sum + new Date(point.timestamp).getTime(), 0) / slice.length;
              const avgY = slice.reduce((sum, point) => sum + point.value, 0) / slice.length;
              reduced.push({ x: new Date(avgX), y: avgY });
            }
            return reduced;
          }
          
          // Update PV Power Chart datasets
          if (pvPowerChart) {
            const pvTotalData = filterAndReduce(data['solar_assistant/inverter_1/pv_power/state'], 100);
            const pv1Data = filterAndReduce(data['solar_assistant/inverter_1/pv_power_1/state'], 80);
            const pv2Data = filterAndReduce(data['solar_assistant/inverter_1/pv_power_2/state'], 80);
            
            pvPowerChart.data.datasets[0].data = pvTotalData;
            if (pvPowerChart.data.datasets[1]) pvPowerChart.data.datasets[1].data = pv1Data;
            if (pvPowerChart.data.datasets[2]) pvPowerChart.data.datasets[2].data = pv2Data;
            
            pvPowerChart.options.scales.x.min = startTime;
            pvPowerChart.options.scales.x.max = now;
            pvPowerChart.options.scales.x.time.unit = timeUnit;
            pvPowerChart.options.scales.x.time.displayFormats = displayFormats;
            pvPowerChart.options.scales.x.ticks.maxTicksLimit = maxTicks;
            pvPowerChart.update('none');
          }
          
          // Update Battery SOC Chart
          if (batterySocChart) {
            const socData = filterAndReduce(data['solar_assistant/total/battery_state_of_charge/state'], 100);
            
            batterySocChart.data.datasets[0].data = socData;
            batterySocChart.options.scales.x.min = startTime;
            batterySocChart.options.scales.x.max = now;
            batterySocChart.options.scales.x.time.unit = timeUnit;
            batterySocChart.options.scales.x.time.displayFormats = displayFormats;
            batterySocChart.options.scales.x.ticks.maxTicksLimit = maxTicks;
            batterySocChart.update('none');
          }
          
          // Update Load Power Chart
          if (loadPowerChart) {
            const loadData = filterAndReduce(data['solar_assistant/inverter_1/load_power/state'], 100);
            
            loadPowerChart.data.datasets[0].data = loadData;
            loadPowerChart.options.scales.x.min = startTime;
            loadPowerChart.options.scales.x.max = now;
            loadPowerChart.options.scales.x.time.unit = timeUnit;
            loadPowerChart.options.scales.x.time.displayFormats = displayFormats;
            loadPowerChart.options.scales.x.ticks.maxTicksLimit = maxTicks;
            loadPowerChart.update('none');
          }
        })
        .catch(error => {
          console.error('Error fetching historical data:', error);
        });
      
      // Update chart titles
      const periodLabels = {
        '1hour': 'Past 1 Hour',
        '12hours': 'Past 12 Hours',
        '24hours': 'Past 24 Hours',
        '48hours': 'Past 48 Hours',
        '7days': 'Past 7 Days',
        '1month': 'Past Month',
        '1year': 'Past Year'
      };
      
      const periodLabel = periodLabels[period] || 'Past 1 Hour';
      
      const trendsTitle = document.getElementById('trendsTitle');
      const pvPowerTitle = document.getElementById('pvPowerTitle');
      const batterySocTitle = document.getElementById('batterySocTitle');
      const loadPowerTitle = document.getElementById('loadPowerTitle');
      
      if (trendsTitle) trendsTitle.textContent = '📊 ' + periodLabel + ' Trends';
      if (pvPowerTitle) pvPowerTitle.textContent = '☀️ Solar Power - Total & Per Array (' + periodLabel + ')';
      if (batterySocTitle) batterySocTitle.textContent = '🔋 Battery State of Charge (' + periodLabel + ')';
      if (loadPowerTitle) loadPowerTitle.textContent = '⚡ Load Power (' + periodLabel + ')';
      
      // Update peak performance for the selected time period
      updatePeakPerformance(period);
      
      // Show the charts now that a time period has been selected
      const pvContainer = document.getElementById('pvPowerChartContainer');
      const batteryContainer = document.getElementById('batterySocChartContainer');
      const loadContainer = document.getElementById('loadPowerChartContainer');
      
      if (pvContainer) pvContainer.style.display = 'block';
      if (batteryContainer) batteryContainer.style.display = 'block';
      if (loadContainer) loadContainer.style.display = 'block';
      
      console.log('Time period changed to:', period, 'Time range:', startTime, 'to', now);
    }
    
    // Function to update peak performance based on time period
    function updatePeakPerformance(period) {
      const timeRangeMap = {
        '1hour': 1,
        '12hours': 12,
        '24hours': 24,
        '48hours': 48,
        '7days': 168,
        '1month': 720,
        '1year': 8760
      };
      
      const periodLabelMap = {
        '1hour': 'Past hour',
        '12hours': 'Past 12 hours',
        '24hours': 'Past 24 hours',
        '48hours': 'Past 48 hours',
        '7days': 'Past 7 days',
        '1month': 'Past month',
        '1year': 'Past year'
      };
      
      const hours = timeRangeMap[period];
      const label = periodLabelMap[period] || 'All-time record';
      
      // Fetch peak performance from API
      fetch('/data/peak-performance?hours=' + hours)
        .then(response => response.json())
        .then(data => {
          const peakProductionEl = document.getElementById('peakProduction');
          const peakProductionLabelEl = document.getElementById('peakProductionLabel');
          
          if (peakProductionEl) peakProductionEl.textContent = data.peak;
          if (peakProductionLabelEl) peakProductionLabelEl.textContent = label;
        })
        .catch(error => console.error('Error updating peak performance:', error));
    }
    
    // Function to change solar array view
    function changeSolarArrayView(view) {
      if (!pvPowerChart) return;
      
      // Hide/show datasets based on selection
      pvPowerChart.data.datasets.forEach((dataset, index) => {
        if (view === 'all') {
          // Show all datasets
          dataset.hidden = false;
        } else if (view === 'total') {
          // Show only total (index 0)
          dataset.hidden = (index !== 0);
        } else if (view === 'array1') {
          // Show only Array 1 (index 1)
          dataset.hidden = (index !== 1);
        } else if (view === 'array2') {
          // Show only Array 2 (index 2)
          dataset.hidden = (index !== 2);
        }
      });
      
      pvPowerChart.update();
      console.log('Solar array view changed to:', view);
    }
    
    // Settings Modal Functions
    function openSettingsModal() {
      document.getElementById('settingsModal').style.display = 'block';
      loadSettings();
    }
    
    function closeSettingsModal() {
      document.getElementById('settingsModal').style.display = 'none';
    }
    
    function toggleChargerSettings() {
      const enabled = document.getElementById('chargerEnabled').checked;
      document.getElementById('chargerSettings').style.display = enabled ? 'block' : 'none';
    }
    
    function loadSettings() {
      fetch('/settings/alerts')
        .then(response => response.json())
        .then(data => {
          document.getElementById('alertEnabled').checked = data.settings.enabled;
          document.getElementById('toEmail').value = data.settings.toEmail;
          document.getElementById('lowThreshold').value = data.settings.lowThreshold;
          document.getElementById('highThreshold').value = data.settings.highThreshold;
          
          // Load charger control settings
          if (data.settings.chargerControl) {
            document.getElementById('chargerEnabled').checked = data.settings.chargerControl.enabled;
            document.getElementById('chargerLowThreshold').value = data.settings.chargerControl.lowThreshold;
            document.getElementById('chargerHighThreshold').value = data.settings.chargerControl.highThreshold;
            document.getElementById('chargerPlugName').value = data.settings.chargerControl.plugName;
            document.getElementById('chargerMaxTemp').value = data.settings.chargerControl.maxTemp;
            
            // Show/hide charger settings based on enabled state
            document.getElementById('chargerSettings').style.display = data.settings.chargerControl.enabled ? 'block' : 'none';
          }
          
          // Update charger state display
          if (data.chargerState) {
            const statusSpan = document.getElementById('chargerStatusDisplay');
            const actionSpan = document.getElementById('chargerLastActionDisplay');
            const socSpan = document.getElementById('chargerLastSOCDisplay');
            
            if (statusSpan) {
              statusSpan.textContent = data.chargerState.isOn ? '🟢 ON' : '🔴 OFF';
              statusSpan.style.color = data.chargerState.isOn ? '#4ade80' : '#f87171';
            }
            if (actionSpan) {
              actionSpan.textContent = data.chargerState.lastAction ? 
                data.chargerState.lastAction + ' at ' + new Date(data.chargerState.lastActionTime).toLocaleString() : 
                'None';
            }
            if (socSpan) {
              socSpan.textContent = data.chargerState.lastSOC ? data.chargerState.lastSOC + '%' : '-';
            }
          }
          
          // Load peak discharge settings
          if (data.settings.peakDischargeAlert) {
            document.getElementById('peakDischargeEnabled').checked = data.settings.peakDischargeAlert.enabled;
            document.getElementById('peakDischargeDuration').value = data.settings.peakDischargeAlert.durationMinutes;
          }
          
          // Show alert state
          const stateDiv = document.getElementById('alertState');
          if (data.state.lastAlertTime) {
            stateDiv.innerHTML = 'Last Alert: ' + data.state.lastAlertType + ' at ' + new Date(data.state.lastAlertTime).toLocaleString();
          } else {
            stateDiv.innerHTML = 'No alerts sent yet';
          }
          
          // Show alert history
          const historyDiv = document.getElementById('alertHistory');
          if (historyDiv && data.history && data.history.length > 0) {
            let historyHTML = '<div style="max-height: 200px; overflow-y: auto; margin-top: 10px;">';
            historyHTML += '<table class="alert-history-table">';
            historyHTML += '<thead><tr><th>Time</th><th>Type</th><th>Message</th></tr></thead>';
            historyHTML += '<tbody>';
            
            data.history.forEach(alert => {
              const alertType = alert.type === 'low' ? '⚠️ Low' : '✅ Recovered';
              const alertColor = alert.type === 'low' ? '#f87171' : '#4ade80';
              const time = new Date(alert.timestamp).toLocaleString();
              historyHTML += '<tr>';
              historyHTML += '<td class="time-cell">' + time + '</td>';
              historyHTML += '<td style="color: ' + alertColor + '; font-weight: bold;">' + alertType + '</td>';
              historyHTML += '<td>' + alert.message + '</td>';
              historyHTML += '</tr>';
            });
            
            historyHTML += '</tbody></table></div>';
            historyDiv.innerHTML = historyHTML;
          } else if (historyDiv) {
            historyDiv.innerHTML = '<p class="alert-history-empty">No alert history yet</p>';
          }
          
          // Load daily summary settings
          if (data.settings.dailySummary) {
            document.getElementById('dailySummaryEnabled').checked = data.settings.dailySummary.enabled;
            document.getElementById('dailySummaryTime').value = data.settings.dailySummary.sendTime;
          }
          
          // Update next summary time
          updateNextSummaryTime();
        })
        .catch(error => console.error('Error loading settings:', error));
    }
    
    function saveSettings() {
      const settings = {
        enabled: document.getElementById('alertEnabled').checked,
        toEmail: document.getElementById('toEmail').value,
        lowThreshold: parseFloat(document.getElementById('lowThreshold').value),
        highThreshold: parseFloat(document.getElementById('highThreshold').value),
        chargerControl: {
          enabled: document.getElementById('chargerEnabled').checked,
          lowThreshold: parseFloat(document.getElementById('chargerLowThreshold').value),
          highThreshold: parseFloat(document.getElementById('chargerHighThreshold').value),
          plugName: document.getElementById('chargerPlugName').value,
          maxTemp: parseFloat(document.getElementById('chargerMaxTemp').value)
        },
        peakDischargeAlert: {
          enabled: document.getElementById('peakDischargeEnabled').checked,
          durationMinutes: parseInt(document.getElementById('peakDischargeDuration').value)
        },
        dailySummary: {
          enabled: document.getElementById('dailySummaryEnabled').checked,
          sendTime: document.getElementById('dailySummaryTime').value,
          timezone: 'America/Phoenix'
        }
      };
      
      fetch('/settings/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      })
        .then(response => response.json())
        .then(data => {
          if (data.success) {
            alert('✅ Settings saved successfully!');
            closeSettingsModal();
          } else {
            alert('❌ Error saving settings: ' + data.error);
          }
        })
        .catch(error => {
          alert('❌ Error saving settings: ' + error.message);
        });
    }
    
    function sendTestEmail() {
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = 'Sending...';
      
      fetch('/settings/alerts/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
        .then(response => response.json())
        .then(data => {
          if (data.success) {
            alert('✅ ' + data.message);
          } else {
            alert('❌ ' + data.message);
          }
          btn.disabled = false;
          btn.textContent = '📧 Send Test Email';
        })
        .catch(error => {
          alert('❌ Error: ' + error.message);
          btn.disabled = false;
          btn.textContent = '📧 Send Test Email';
        });
    }
    
    function testThreshold(soc) {
      fetch('/settings/alerts/test-threshold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ soc: soc })
      })
        .then(response => response.json())
        .then(data => {
          if (data.success) {
            const state = data.currentState;
            const charger = data.chargerState;
            let message = '✅ ' + data.message + '\\n\\n';
            message += 'Current Alert State:\\n';
            message += '• Below Threshold: ' + (state.belowThreshold ? 'YES' : 'NO') + '\\n';
            message += '• Last Alert Type: ' + (state.lastAlertType || 'None') + '\\n';
            message += '• Low Threshold: ' + state.lowThreshold + '%\\n';
            message += '• High Threshold: ' + state.highThreshold + '%\\n\\n';
            
            if (charger && charger.chargerEnabled) {
              message += 'Charger State:\\n';
              message += '• Charger: ' + (charger.isOn ? '🟢 ON' : '🔴 OFF') + '\\n';
              message += '• Last Action: ' + (charger.lastAction || 'None') + '\\n';
              message += '• Last SOC: ' + (charger.lastSOC ? charger.lastSOC + '%' : '-') + '\\n\\n';
            }
            
            message += 'Check terminal for detailed logs and your email for notifications.';
            alert(message);
            
            // Reload alert history and charger state
            loadSettings();
          } else {
            alert('❌ ' + data.message);
          }
        })
        .catch(error => {
          alert('❌ Error: ' + error.message);
        });
    }
    
    function testChargerControl(action) {
      const statusDiv = document.getElementById('chargerTestStatus');
      statusDiv.innerHTML = '<span style="color: var(--warning-color);">⏳ Sending ' + action.toUpperCase() + ' command...</span>';
      
      fetch('/settings/charger/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action })
      })
        .then(response => response.json())
        .then(data => {
          if (data.success) {
            const state = data.chargerState;
            let message = '<span style="color: var(--success-color);">✅ ' + data.message + '</span><br><br>';
            message += '<strong>Charger State:</strong><br>';
            message += '• Status: ' + (state.isOn ? '🟢 ON' : '🔴 OFF') + '<br>';
            message += '• Last Action: ' + (state.lastAction || 'None') + '<br>';
            message += '• Reason: ' + (state.lastActionReason || 'N/A') + '<br>';
            message += '• Time: ' + (state.lastActionTime ? new Date(state.lastActionTime).toLocaleString() : 'N/A') + '<br><br>';
            message += '<small style="color: var(--text-muted);">Check your TP-Link smart plug to verify the action.</small>';
            statusDiv.innerHTML = message;
          } else {
            statusDiv.innerHTML = '<span style="color: var(--danger-color);">❌ ' + (data.message || data.error) + '</span>';
          }
        })
        .catch(error => {
          statusDiv.innerHTML = '<span style="color: var(--danger-color);">❌ Error: ' + error.message + '</span>';
        });
    }
    
    // Daily Summary Functions
    function sendTestDailySummary() {
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = 'Sending...';
      
      fetch('/settings/daily-summary/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
        .then(response => response.json())
        .then(data => {
          if (data.success) {
            alert('✅ Daily summary sent successfully! Check your email.');
          } else {
            alert('❌ Error: ' + data.message);
          }
          btn.disabled = false;
          btn.textContent = '📊 Send Test Daily Summary';
        })
        .catch(error => {
          alert('❌ Error: ' + error.message);
          btn.disabled = false;
          btn.textContent = '📊 Send Test Daily Summary';
        });
    }
    
    function updateNextSummaryTime() {
      const sendTime = document.getElementById('dailySummaryTime').value;
      const enabled = document.getElementById('dailySummaryEnabled').checked;
      
      if (!enabled) {
        document.getElementById('nextSummaryTime').textContent = 'Disabled';
        return;
      }
      
      const now = new Date();
      const [hours, minutes] = sendTime.split(':');
      const todaySendTime = new Date(now);
      todaySendTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
      
      const tomorrowSendTime = new Date(todaySendTime);
      tomorrowSendTime.setDate(tomorrowSendTime.getDate() + 1);
      
      const nextSendTime = now < todaySendTime ? todaySendTime : tomorrowSendTime;
      
      document.getElementById('nextSummaryTime').textContent = nextSendTime.toLocaleString();
    }
    
    // Update next summary time when time changes
    document.addEventListener('DOMContentLoaded', function() {
      const timeInput = document.getElementById('dailySummaryTime');
      const enabledCheckbox = document.getElementById('dailySummaryEnabled');
      
      if (timeInput) {
        timeInput.addEventListener('change', updateNextSummaryTime);
      }
      if (enabledCheckbox) {
        enabledCheckbox.addEventListener('change', updateNextSummaryTime);
      }
    });
    
    // Close modal when clicking outside
    window.onclick = function(event) {
      const modal = document.getElementById('settingsModal');
      if (event.target == modal) {
        closeSettingsModal();
      }
    }
  </script>
  
  <!-- Settings Modal -->
  <div id="settingsModal" class="modal">
    <div class="modal-content">
      <span class="close" onclick="closeSettingsModal()">&times;</span>
      <h2>⚙️ Alert Settings</h2>
      
      <div class="settings-form">
        <div class="form-group">
          <label>
            <input type="checkbox" id="alertEnabled" checked>
            Enable Email Alerts
          </label>
        </div>
        
        <div class="form-group">
          <label for="toEmail">Email Address:</label>
          <input type="email" id="toEmail" placeholder="john@crowninternet.com">
        </div>
        
        <div class="form-group">
          <label for="lowThreshold">Low Battery Threshold (%):</label>
          <input type="number" id="lowThreshold" min="0" max="100" value="50">
          <small>Send alert when battery drops below this level</small>
        </div>
        
        <div class="form-group">
          <label for="highThreshold">Recovery Threshold (%):</label>
          <input type="number" id="highThreshold" min="0" max="100" value="80">
          <small>Send alert when battery recovers above this level</small>
        </div>
        
        <div class="alert-state" id="alertState">
          No alerts sent yet
        </div>
        
        <div style="margin: 20px 0;">
          <h3 class="alert-history-title">📜 Alert History (Last 10)</h3>
          <div id="alertHistory" class="alert-history-container">
            <p class="alert-history-empty">No alert history yet</p>
          </div>
        </div>
        
        <div class="form-actions">
          <button onclick="sendTestEmail()" class="btn-test">📧 Send Test Email</button>
          <button onclick="closeSettingsModal()" class="btn-secondary">Cancel</button>
        </div>
        
        <!-- Charger Control Section -->
        <div style="margin-top: 20px; padding-top: 20px; border-top: 2px solid var(--border-color);">
          <h3 class="alert-history-title">🔌 Automatic Charger Control (IFTTT)</h3>
          
          <div class="form-group">
            <label>
              <input type="checkbox" id="chargerEnabled" onchange="toggleChargerSettings()">
              Enable Automatic Charger Control
            </label>
            <small style="color: var(--text-muted); display: block; margin-top: 5px;">
              Automatically control a TP-Link smart plug via IFTTT based on battery level
            </small>
          </div>
          
          <div id="chargerSettings" style="display: none; margin-top: 15px;">
            <div class="form-group">
              <label for="chargerLowThreshold">Turn ON Charger at (%):</label>
              <input type="number" id="chargerLowThreshold" value="45" min="10" max="50" step="1">
              <small style="color: var(--text-muted);">Charger will turn ON when battery drops to this level</small>
            </div>
            
            <div class="form-group">
              <label for="chargerHighThreshold">Turn OFF Charger at (%):</label>
              <input type="number" id="chargerHighThreshold" value="85" min="60" max="95" step="1">
              <small style="color: var(--text-muted);">Charger will turn OFF when battery reaches this level</small>
            </div>
            
            <div class="form-group">
              <label for="chargerMaxTemp">Max Safe Temperature (°F):</label>
              <input type="number" id="chargerMaxTemp" value="110" min="80" max="130" step="1">
              <small style="color: var(--text-muted);">Charger will not activate if battery temperature exceeds this</small>
            </div>
            
            <div class="form-group">
              <label for="chargerPlugName">Smart Plug Name:</label>
              <input type="text" id="chargerPlugName" value="Battery Charger" placeholder="e.g., Battery Charger">
              <small style="color: var(--text-muted);">Friendly name for notifications</small>
            </div>
            
            <div style="background: var(--card-bg); border: 2px solid var(--border-color); padding: 15px; border-radius: 8px; margin-top: 15px;">
              <strong style="color: var(--text-primary); display: block; margin-bottom: 10px;">📊 Current Charger State:</strong>
              <div style="color: var(--text-secondary); font-size: 13px; line-height: 1.6;">
                <div>Status: <span id="chargerStatusDisplay" style="font-weight: 600;">Unknown</span></div>
                <div>Last Action: <span id="chargerLastActionDisplay">None</span></div>
                <div>Last SOC: <span id="chargerLastSOCDisplay">-</span></div>
                <div style="margin-top: 8px; font-size: 11px; color: var(--text-muted);">
                  ⚡ Webhooks configured for battery_low and battery_charged events
                </div>
              </div>
            </div>
          </div>
        </div>
        
        <div style="margin-top: 20px; padding-top: 20px; border-top: 2px solid var(--border-color);">
          <h3 style="color: var(--text-primary); font-size: 16px; margin-bottom: 15px;">🧪 Test Alert Thresholds</h3>
          <p style="color: var(--text-secondary); font-size: 13px; margin-bottom: 15px;">Simulate different battery SOC values to test alert notifications:</p>
          
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px;">
            <button onclick="testThreshold(45)" class="btn-test" style="background: #f39c12;">⚠️ Test Low (45%)</button>
            <button onclick="testThreshold(95)" class="btn-test" style="background: #27ae60;">✅ Test Recovery (95%)</button>
          </div>
          
          <p style="color: var(--text-muted); font-size: 11px; margin-top: 10px;">
            <strong>Manual Override:</strong> These test buttons bypass ALL settings, thresholds, and cooldowns.
            Watch the terminal for alert messages and check your email.
          </p>
        </div>
        
        <div style="margin-top: 20px; padding-top: 20px; border-top: 2px solid var(--border-color);">
          <h3 style="color: var(--text-primary); font-size: 16px; margin-bottom: 15px;">🔌 Test Charger Control</h3>
          <p style="color: var(--text-secondary); font-size: 13px; margin-bottom: 15px;">
            Manually trigger the IFTTT smart plug to test the charger ON/OFF commands:
          </p>
          
          <div style="display: flex; gap: 10px; margin-bottom: 15px;">
            <button onclick="testChargerControl('on')" class="btn-test" style="flex: 1; background: #27ae60;">
              🔋 Turn Charger ON
            </button>
            <button onclick="testChargerControl('off')" class="btn-test" style="flex: 1; background: #e74c3c;">
              ⚡ Turn Charger OFF
            </button>
          </div>
          
          <div id="chargerTestStatus" style="padding: 10px; background: var(--card-bg); border-radius: 8px; font-size: 12px; color: var(--text-secondary); border: 1px solid var(--border-color);">
            Ready to test charger control
          </div>
          
          <p style="color: var(--text-muted); font-size: 11px; margin-top: 10px;">💡 Check your TP-Link smart plug and terminal for confirmation.</p>
        </div>
        
        <!-- Peak Discharge Alert Section -->
        <div style="margin-top: 20px; padding-top: 20px; border-top: 2px solid var(--border-color);">
          <h3 style="color: var(--text-primary); font-size: 16px; margin-bottom: 15px;">☀️ Peak Discharge Monitoring</h3>
          
          <div class="form-group">
            <label>
              <input type="checkbox" id="peakDischargeEnabled" checked>
              Enable Peak Discharge Alerts
            </label>
            <small style="color: var(--text-muted); display: block; margin-top: 5px;">
              Get notified when battery discharges during peak sunlight hours (seasonally adjusted)
            </small>
          </div>
          
          <div class="form-group">
            <label for="peakDischargeDuration">Alert After (minutes):</label>
            <input type="number" id="peakDischargeDuration" min="5" max="120" value="30" style="width: 100px;">
            <small style="color: var(--text-muted); display: block; margin-top: 5px;">
              Receive alert if battery discharges for this duration during peak hours
            </small>
          </div>
          
          <div style="background: var(--card-bg); padding: 15px; border-radius: 8px; border-left: 3px solid #f39c12; margin-top: 15px;">
            <h4 style="color: var(--text-primary); font-size: 13px; margin-top: 0;">📅 Seasonal Peak Hours</h4>
            <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.6;">
              <div style="margin-bottom: 5px;"><strong>Summer (Jun-Aug):</strong> 10:00 AM - 3:00 PM</div>
              <div style="margin-bottom: 5px;"><strong>Spring/Fall (Mar-May, Sep-Oct):</strong> 9:45 AM - 2:15 PM</div>
              <div><strong>Winter (Nov-Feb):</strong> 10:00 AM - 2:00 PM</div>
            </div>
          </div>
        </div>
        
        <!-- Daily Summary Section -->
        <div style="margin-top: 20px; padding-top: 20px; border-top: 2px solid var(--border-color);">
          <h3 style="color: var(--text-primary); font-size: 16px; margin-bottom: 15px;">📊 Daily Summary Reports</h3>
          
          <div class="form-group">
            <label>
              <input type="checkbox" id="dailySummaryEnabled" checked>
              Enable Daily Summary Emails
            </label>
            <small style="color: var(--text-muted); display: block; margin-top: 5px;">
              Receive comprehensive daily reports at 8:00 PM with energy statistics, weather impact, and system insights
            </small>
          </div>
          
          <div class="form-group">
            <label for="dailySummaryTime">Send Time:</label>
            <input type="time" id="dailySummaryTime" value="20:00" min="00:00" max="23:59">
            <small style="color: var(--text-muted); display: block; margin-top: 5px;">
              Daily summary emails will be sent at this time (24-hour format)
            </small>
          </div>
          
          <div style="background: var(--card-bg); border: 2px solid var(--border-color); padding: 15px; border-radius: 8px; margin-top: 15px;">
            <strong style="color: var(--text-primary); display: block; margin-bottom: 10px;">📧 Daily Summary Includes:</strong>
            <div style="color: var(--text-secondary); font-size: 13px; line-height: 1.6;">
              <div>• 📊 Energy production and consumption totals</div>
              <div>• 🔋 Battery performance and SOC changes</div>
              <div>• 🌤️ Weather impact on solar production</div>
              <div>• ⚡ Peak power generation times</div>
              <div>• 💡 Efficiency insights and recommendations</div>
              <div>• 🔗 Direct link to full dashboard</div>
              <div style="margin-top: 8px; font-size: 11px; color: var(--text-muted);">
                📅 Next summary: <span id="nextSummaryTime">Calculating...</span>
              </div>
            </div>
          </div>
          
          <div style="margin-top: 15px;">
            <button onclick="sendTestDailySummary()" class="btn-test" style="background: #8e44ad;">📊 Send Test Daily Summary</button>
            <small style="color: var(--text-muted); display: block; margin-top: 5px;">Send a test daily summary email now</small>
          </div>
        </div>
        
        <!-- Save All Settings Button -->
        <div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid var(--border-color); text-align: center;">
          <button onclick="saveSettings()" class="btn-primary" style="padding: 15px 40px; font-size: 16px; font-weight: 600;">💾 Save All Settings</button>
          <p style="color: var(--text-muted); font-size: 12px; margin-top: 10px;">Saves all settings across all sections</p>
        </div>
        
      </div>
      
    </div>
  </div>
</body>
</html>
  `;
  
  res.send(html);
});

/**
 * Get current value for a topic
 */
function getCurrentValue(topic) {
  if (cachedData[topic] && cachedData[topic].value !== null && cachedData[topic].value !== undefined) {
    const value = parseFloat(cachedData[topic].value);
    if (isNaN(value)) return '-';
    
    // Show one decimal place for battery SOC for more precision
    if (topic === 'solar_assistant/total/battery_state_of_charge/state') {
      return value.toFixed(1);
    }
    
    return Math.round(value);
  }
  return '-';
}

/**
 * Get last update time for a topic
 */
function getUpdateTime(topic) {
  if (cachedData[topic] && cachedData[topic].timestamp) {
    return new Date(cachedData[topic].timestamp).toLocaleTimeString();
  }
  return 'N/A';
}

/**
 * Escapes HTML special characters
 */
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

// ═══════════════════════════════════════════════════════════════════════════
// APPLICATION STARTUP
// ═══════════════════════════════════════════════════════════════════════════
// EXECUTION ORDER:
// 1. Load historical data and settings from disk
// 2. Connect to MQTT broker (client.on handlers above)
// 3. Start weather update interval (every 5 minutes)
// 4. Start data save interval (every 60 seconds)
// 5. Start HTTP server (Express)
// 6. Dashboard polls /data every 3 seconds
// 7. MQTT messages continuously update cachedData
// 8. Charger control triggers based on battery SOC
//
// MONITORING:
// - Dashboard: http://localhost:3434
// - Real-time data: http://localhost:3434/data
// - Historical data: http://localhost:3434/data/history
// - Settings: Click gear icon on dashboard
//
// MAINTENANCE:
// - Data saved every 60 seconds to JSON files
// - Old data pruned after DATA_RETENTION_DAYS (365 days)
// - Settings persist across restarts
// - Charger state persists across restarts (prevents duplicate triggers)

// SSL Certificate Configuration
const SSL_OPTIONS = {
  key: fs.readFileSync('./ssl/server.key'),
  cert: fs.readFileSync('./ssl/server.crt')
};

// Start the HTTPS server
https.createServer(SSL_OPTIONS, app).listen(PORT, () => {
  console.log(`\n🔒 HTTPS Server running on https://localhost:${PORT}`);
  console.log(`📊 Dashboard: https://localhost:${PORT}/`);
  console.log(`📡 API endpoint: https://localhost:${PORT}/data`);
  console.log(`📈 Historical data: https://localhost:${PORT}/data/history`);
  console.log(`🔐 Login: https://localhost:${PORT}/login`);
  console.log(`\n⚠️  Self-signed certificate - browser will show security warning`);
  console.log(`   Click "Advanced" → "Proceed to localhost (unsafe)"`);
  console.log(`\nPress Ctrl+C to stop\n`);
});

// ═══════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN HANDLER
// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE: Save data before exiting to prevent loss
// TRIGGERED BY: Ctrl+C (SIGINT signal)
// IMPACT: Saves historicalData and dailyStats before closing MQTT connection

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  saveHistoricalData(); // Save data before exiting
  saveDailyStats(); // Save daily stats before exiting
  client.end();
  process.exit(0);
});
