# ☀️ SolarAssistant MQTT Dashboard

A comprehensive Node.js dashboard that monitors your SolarAssistant solar power system via MQTT, featuring real-time updates, historical charts, dark mode, weather integration, email alerts, and automated battery charger control via IFTTT.

**Current Version:** v8.20.0

---

## 💡 What it does

- Runs locally on `http://localhost:3434`
- Connects to your SolarAssistant MQTT broker
- Subscribes to all SolarAssistant topics (`solar_assistant/#`)
- **Real-time updates every 3 seconds** for instant monitoring
- **60-second interval data archival** for efficient chart storage
- **365-day historical data retention** with automatic pruning
- Beautiful, responsive web interface with dark mode support
- Email alerts for low battery conditions
- Automated battery charger control via IFTTT webhooks
- Weather data integration from Open-Meteo API

---

## 🚀 Quick Start

### Prerequisites

- Node.js (v14 or higher)
- SolarAssistant device with MQTT enabled on your local network
- (Optional) SendGrid API key for email alerts
- (Optional) IFTTT account with TP-Link Kasa integration for automated charger control

### Installation & Run

```bash
npm install
node app.js
```

The server will start on `http://localhost:3434`

---

## 🎨 Features

### 🖥️ **User Interface**
- ✅ **Dark Mode Toggle** - Switch between light and dark themes (persisted to localStorage)
- ✅ **Responsive Design** - Optimized for desktop, tablet, and mobile
- ✅ **Drag & Drop Layout** - Customize dashboard widget order (powered by Sortable.js)
- ✅ **WCAG AA Compliant** - 4.5:1 minimum contrast ratio for accessibility
- ✅ **Real-time Updates** - Screen refreshes every 3 seconds
- ✅ **Smooth Animations** - Polished transitions and hover effects

### 📊 **Data Visualization**
- ✅ **Historical Charts** (powered by Chart.js):
  - Solar Power (Total + Array 1 + Array 2 combined)
  - Battery State of Charge (%)
  - Load Power consumption
- ✅ **Time Period Selector** - View data from 1 hour to 1 year
- ✅ **Data Point Reduction** - Intelligent smoothing for clean, readable charts
- ✅ **Interactive Tooltips** - Hover to see exact values and timestamps
- ✅ **Dynamic Legend** - Toggle datasets on/off

### 📈 **Live Metrics Display**
- ✅ **Current Values** with real-time updates:
  - Total Solar Power (W)
  - Array 1 Power (W)
  - Array 2 Power (W)
  - Battery State of Charge (%) - with decimal precision
  - Battery Voltage (V)
  - Load Power (W)
  - Peak Performance (all-time record)
- ✅ **Weather Integration**:
  - Current temperature
  - Humidity
  - Wind speed
  - Cloud cover
  - Solar radiation (W/m²)
- ✅ **Daily Statistics**:
  - Total energy produced today
  - Total energy consumed today
  - Battery runtime estimate
  - Peak production today

### 🔔 **Alert System**
- ✅ **Email Notifications** (via SendGrid):
  - Low battery alert (configurable threshold, default 50%)
  - Battery recovery notification (configurable threshold, default 80%)
  - Alert history tracking (last 10 alerts)
  - Test email functionality
- ✅ **Configurable Settings**:
  - Enable/disable alerts
  - Set custom thresholds
  - Configure recipient email
  - Test alert thresholds with simulated SOC values

### 🔌 **Smart Charger Control** (IFTTT Integration)
- ✅ **Automated Battery Charging**:
  - Automatically turns ON charger when battery drops below threshold (default 45%)
  - Automatically turns OFF charger when battery reaches target (default 85%)
  - Temperature safety monitoring (disables charging if battery too hot)
  - 5-minute cooldown between actions to prevent rapid cycling
- ✅ **Manual Testing**:
  - Test ON/OFF commands directly from settings modal
  - Real-time feedback on charger state
  - Terminal logging with test indicators
- ✅ **State Tracking**:
  - Current charger status (ON/OFF)
  - Last action and reason
  - Last SOC when action was taken
  - Timestamp of last action
  - Persistent state storage

### 💾 **Data Management**
- ✅ **Historical Data Storage** - Saved to `data_history.json`
- ✅ **Daily Statistics** - Saved to `daily_stats.json` (resets at midnight)
- ✅ **Alert Settings Persistence** - Saved to `alert_settings.json`
- ✅ **Automatic Pruning** - Removes data older than 365 days
- ✅ **Efficient Archival** - Stores data points every 60 seconds for charts
- ✅ **Real-time Cache** - Updates every MQTT message for instant display

---

## 📡 API Endpoints

### Dashboard
**URL:** `GET http://localhost:3434/`

Beautiful HTML dashboard with all features listed above.

### Current Data API
**URL:** `GET http://localhost:3434/data`

Returns all cached MQTT data with metadata:
```json
{
  "data": {
    "solar_assistant/inverter_1/battery_voltage/state": {
      "value": 54.2,
      "timestamp": "2025-10-10T12:34:56.789Z",
      "raw": "54.2"
    }
  },
  "lastUpdate": "2025-10-10T12:34:56.790Z",
  "messageCount": 142,
  "status": "Connected",
  "topics": 35
}
```

### Historical Data API
**URL:** `GET http://localhost:3434/data/history`

Returns historical data for charted metrics (up to 365 days).

### Daily Statistics API
**URL:** `GET http://localhost:3434/data/daily-stats`

Returns today's statistics including energy totals and battery runtime.

### Alert Settings API
**URL:** `GET http://localhost:3434/settings/alerts`

Returns current alert settings, state, and history.

**URL:** `POST http://localhost:3434/settings/alerts`

Update alert settings (enabled, thresholds, email, charger control).

### Test Endpoints
**URL:** `POST http://localhost:3434/settings/alerts/test`

Send a test email notification.

**URL:** `POST http://localhost:3434/settings/alerts/test-threshold`

Test alert system with simulated SOC value.

**URL:** `POST http://localhost:3434/settings/charger/test`

Manually test charger control (ON/OFF) via IFTTT.

---

## ⚙️ Configuration

### MQTT Broker Settings

Edit the constants at the top of `app.js`:

```javascript
const PORT = 3434;                              // Web server port
const MQTT_BROKER = 'mqtt://192.168.1.228:1883'; // Your MQTT broker URL
const MQTT_TOPIC = 'solar_assistant/#';          // Topic to subscribe to
const SAVE_INTERVAL = 60000;                     // Save to disk every 60 seconds
const DATA_RETENTION_DAYS = 365;                 // Keep 365 days of historical data
const ARCHIVE_INTERVAL = 60000;                  // Archive data every 60 seconds for charts
```

### Email Alert Configuration

Configure via the Settings modal (⚙️ button) in the dashboard, or edit `alert_settings.json`:

```json
{
  "enabled": true,
  "sendgridApiKey": "YOUR_SENDGRID_API_KEY",
  "fromEmail": "notify@yourdomain.com",
  "toEmail": "your@email.com",
  "lowThreshold": 50,
  "highThreshold": 80
}
```

### IFTTT Charger Control Configuration

Configure via the Settings modal in the dashboard:

```json
{
  "chargerControl": {
    "enabled": false,
    "iftttWebhookKey": "YOUR_IFTTT_WEBHOOK_KEY",
    "lowThreshold": 45,
    "highThreshold": 85,
    "plugName": "Battery Charger",
    "maxTemp": 110,
    "cooldownMinutes": 5
  }
}
```

**Required IFTTT Webhooks:**
- Event: `battery_low` - Triggers when battery drops below threshold (turns charger ON)
- Event: `battery_charged` - Triggers when battery reaches target (turns charger OFF)

**IFTTT Setup:**
1. Create account at [ifttt.com](https://ifttt.com)
2. Connect TP-Link Kasa service
3. Create two applets:
   - **IF** Webhooks `battery_low` **THEN** Turn on smart plug
   - **IF** Webhooks `battery_charged` **THEN** Turn off smart plug
4. Get your webhook key from [ifttt.com/maker_webhooks/settings](https://ifttt.com/maker_webhooks/settings)
5. Enter the key in the dashboard settings

### Weather Integration

Weather data is automatically fetched from Open-Meteo API using coordinates configured in `app.js`:

```javascript
const WEATHER_LAT = 36.0;   // Your latitude
const WEATHER_LON = -115.0; // Your longitude
```

### Tracked Topics for Historical Charts

```javascript
const TRACKED_TOPICS = [
  'solar_assistant/inverter_1/pv_power/state',
  'solar_assistant/inverter_1/pv_power_1/state',
  'solar_assistant/inverter_1/pv_power_2/state',
  'solar_assistant/total/battery_state_of_charge/state',
  'solar_assistant/inverter_1/load_power/state'
];
```

---

## 🔧 Advanced Features

### Battery Runtime Calculation

The dashboard automatically calculates estimated battery runtime based on:
- Current battery SOC (State of Charge)
- Current load power consumption
- Battery capacity (300 Ah @ 48V = 14,400 Wh)

Formula: `Runtime = (Available Energy in Wh) / (Current Load in W)`

### Data Point Reduction

Charts use intelligent data reduction to maintain performance:
- Solar charts: Limited to 80 points
- Battery/Load charts: Limited to 60 points
- Uses averaging to preserve trends while reducing visual clutter

### Cache Busting

The dashboard includes aggressive cache busting to ensure you always see the latest version:
- CSS version tracking in comments
- Visible version number in header
- URL timestamp parameter on page load

---

## 🛠️ Technical Stack

- **Backend:** Node.js with Express
- **MQTT Client:** mqtt.js
- **Charts:** Chart.js v4.4.0
- **Drag & Drop:** Sortable.js v1.15.0
- **Email:** SendGrid API
- **Weather:** Open-Meteo API
- **Automation:** IFTTT Webhooks
- **Storage:** JSON file-based persistence

---

## 📝 Console Output Example

```
📂 Loaded historical data from /Users/user/Battery/data_history.json
📊 Loaded daily stats from file
🔌 Loaded charger state: OFF
📧 Loaded alert settings from file
🔌 Connecting to MQTT broker at mqtt://192.168.1.228:1883...
📡 Subscribing to topic: solar_assistant/#

🌐 Server running on http://localhost:3434
📊 Dashboard: http://localhost:3434/
📡 API endpoint: http://localhost:3434/data
📈 Historical data: http://localhost:3434/data/history

Press Ctrl+C to stop

✓ Connected to MQTT broker
✓ Subscribed to solar_assistant/#
📊 Waiting for messages...

✓ Message #1 - Topic: solar_assistant/inverter_1/pv_power/state
  Value: 1250.0
✓ Message #11 - Topic: solar_assistant/total/battery_state_of_charge/state
  Value: 72
🌤️ Weather updated: 92°F, humidity: 34%, wind: 5.9mph
💾 Saved historical data (18069 data points)
```

---

## 🐛 Troubleshooting

### MQTT Connection Issues

**Problem:** Can't connect to MQTT broker  
**Solution:** 
- Verify the IP address and port (default MQTT port is 1883)
- Check that your SolarAssistant has MQTT enabled
- Ensure your computer is on the same network
- Check if authentication is required (see Configuration section)

### Data Display Issues

**Problem:** Connected but no data appearing  
**Solution:** 
- Wait a few moments - MQTT messages may be sent periodically
- Check the console logs to see if messages are being received
- Verify the topic pattern matches your SolarAssistant setup
- Try accessing the SolarAssistant web dashboard to confirm it's generating data

**Problem:** Browser showing old version after update  
**Solution:**
- Perform a hard refresh: `Ctrl+Shift+R` (Windows/Linux) or `Cmd+Shift+R` (Mac)
- Clear browser cache
- Check version number in dashboard header

### Email Alert Issues

**Problem:** Not receiving alert emails  
**Solution:**
- Verify SendGrid API key is valid
- Check spam/junk folder
- Use "Send Test Email" button in settings to verify configuration
- Check terminal logs for error messages

### IFTTT Charger Control Issues

**Problem:** Smart plug not responding  
**Solution:**
- Verify charger control is enabled in settings
- Check IFTTT webhook key is correct
- Test manually using the test buttons in settings modal
- Verify IFTTT applets are enabled and connected to TP-Link Kasa
- Check terminal logs for webhook response status
- Ensure smart plug is online and connected to Wi-Fi

**Problem:** Charger turning on/off too frequently  
**Solution:**
- Adjust the cooldown period (default 5 minutes)
- Increase the threshold gap between low and high thresholds
- Check battery temperature - charging may be disabled if too hot

### Port Issues

**Problem:** Port 3434 already in use  
**Solution:** Change the `PORT` constant in `app.js` to a different port number

**Problem:** "Offline - Reconnecting..." status  
**Solution:**
- The app will automatically retry the connection every 5 seconds
- Check your network connection
- Verify the SolarAssistant device is powered on and accessible

---

## 📊 Dashboard Features Guide

### Main Dashboard

- **Header Status Bar**: Shows MQTT broker name and connection status
- **Time Period Selector**: Choose from 1 hour to 1 year of historical data
- **Theme Toggle**: Switch between light and dark mode (🌙 button)
- **Settings**: Access alert and charger control settings (⚙️ button)

### Value Cards

Each metric is displayed in a card showing:
- Current value with unit
- Visual indicator (color-coded border)
- Last update timestamp
- Drag handles for reordering

### Charts

- **Solar Power Chart**: Shows total production plus individual array breakdown
- **Battery SOC Chart**: Displays battery charge percentage over time
- **Load Power Chart**: Shows power consumption trends
- **View Selector**: Toggle between total solar and individual arrays

### Settings Modal

Three main sections:

1. **Alert Settings**
   - Enable/disable email notifications
   - Set low and high battery thresholds
   - Configure recipient email
   - View alert history
   - Send test email

2. **Charger Control Settings** (IFTTT)
   - Enable/disable automated charger control
   - Set charger on/off thresholds
   - Configure IFTTT webhook key
   - Set maximum safe battery temperature
   - Set cooldown period between actions

3. **Testing Tools**
   - Test alert thresholds with simulated SOC values
   - Manually test charger ON/OFF commands
   - View real-time test results

---

## 🔒 Security Notes

- **API Keys**: SendGrid and IFTTT keys are stored in `alert_settings.json`
- **Key Masking**: API keys are masked in the UI (only last 8 characters shown)
- **Local Network**: Dashboard is designed for local network use only
- **No Authentication**: Consider adding authentication if exposing to internet

---

## 📦 Dependencies

```json
{
  "express": "^4.18.2",
  "mqtt": "^5.3.0"
}
```

**Frontend Libraries (CDN):**
- Chart.js v4.4.0
- Sortable.js v1.15.0

---

## 🔍 Understanding SolarAssistant MQTT Topics

SolarAssistant publishes data to MQTT topics following this pattern:

```
solar_assistant/{device}/{metric}/state
```

Common topics include:
- `solar_assistant/inverter_1/pv_power/state` - Total solar power
- `solar_assistant/inverter_1/pv_power_1/state` - Array 1 power
- `solar_assistant/inverter_1/pv_power_2/state` - Array 2 power
- `solar_assistant/inverter_1/battery_voltage/state` - Battery voltage
- `solar_assistant/total/battery_state_of_charge/state` - Battery SOC
- `solar_assistant/total/battery_power/state` - Battery charge/discharge power
- `solar_assistant/total/battery_temperature/state` - Battery temperature
- `solar_assistant/inverter_1/load_power/state` - Load consumption
- `solar_assistant/inverter_1/grid_power/state` - Grid power

The `#` wildcard subscribes to all topics under `solar_assistant/`.

---

## 📂 File Structure

```
Battery/
├── app.js                  # Main application (backend + frontend HTML)
├── package.json            # Node.js dependencies
├── data_history.json       # Historical data storage (365 days)
├── daily_stats.json        # Daily statistics (resets at midnight)
├── alert_settings.json     # Alert and charger control settings
├── README.md              # This file
├── CHANGELOG.md           # Version history and changes
├── BACKUP_AND_RESTORE.md  # Complete backup and restore guide
└── SECURITY_GUIDE.md      # Authentication, SSL, and security guide
```

---

## 📚 Documentation

### 📖 User Guides
- **[BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md)** - Complete backup and restore procedures
- **[SECURITY_GUIDE.md](SECURITY_GUIDE.md)** - Authentication, SSL setup, and security best practices

### 📋 Reference
- **[CHANGELOG.md](CHANGELOG.md)** - Detailed version history and feature changes
- **[README.md](README.md)** - This overview and quick start guide

### 🔧 Quick Commands
```bash
# Create backup
npm run backup

# Restore latest backup
npm run restore

# Check application status
pm2 status

# View logs
pm2 logs solar-dashboard
```

---

## 🔄 Version History

### v7.1.0 (Current)
- Added manual test buttons for IFTTT charger control
- Test ON/OFF commands directly from settings modal
- Real-time feedback on charger state

### v7.0.0
- Implemented IFTTT smart plug integration for automated battery charger control
- Added charger control settings UI
- Temperature-based safety monitoring
- Cooldown period to prevent rapid cycling
- Charger state persistence

### v6.1.1
- Battery SOC now displays with decimal precision (e.g., 72.5%)

### v6.1.0
- Added Battery Voltage indicator card

### v6.0.1
- Removed header update indicators (Last Update/Next Update)
- Simplified header status bar

### v6.0.0
- Real-time screen updates every 3 seconds
- 60-second interval data archival for efficient storage
- Separated real-time cache from historical data

### v5.3.1
- Fixed modal scrolling for long content

### v5.3.0
- Added alert threshold testing feature
- Test low battery and recovery notifications

### v5.2.3
- Fixed status success color override in light mode

### v5.2.2
- Improved light mode status item styling

### v5.2.1
- Updated text color to white in dark mode

### v5.2.0
- Implemented data point reduction for cleaner charts
- Added data smoothing for better readability
- Improved chart performance with large datasets

### v5.1.0
- Improved dark mode contrast ratios (WCAG AA 4.5:1 compliance)
- Enhanced modal and form element contrast
- Better chart legend visibility

### v5.0.0
- Removed power flow diagrams and gauge charts
- Cleaned up unused code

### v4.x.x
- Dark mode toggle
- Drag-and-drop dashboard customization
- Mobile-responsive design
- Weather integration
- Email alert system

---

## 🎯 Future Enhancement Ideas

- [ ] Historical data export (CSV/JSON)
- [ ] Multiple MQTT broker support
- [ ] User authentication
- [ ] Mobile app (PWA)
- [ ] Push notifications
- [ ] Advanced analytics and forecasting
- [ ] Solar production vs consumption comparison
- [ ] Cost savings calculator
- [ ] Multiple charger support
- [ ] Scheduling (charge during specific hours)

---

## 📄 License

ISC

---

## 🙏 Credits

Built with ❤️ for solar power enthusiasts.

**Technologies:**
- [Node.js](https://nodejs.org/)
- [Express](https://expressjs.com/)
- [MQTT.js](https://github.com/mqttjs/MQTT.js)
- [Chart.js](https://www.chartjs.org/)
- [Sortable.js](https://sortablejs.github.io/Sortable/)
- [SendGrid](https://sendgrid.com/)
- [IFTTT](https://ifttt.com/)
- [Open-Meteo](https://open-meteo.com/)
