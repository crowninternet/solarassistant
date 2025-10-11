# Changelog

All notable changes to the SolarAssistant Dashboard will be documented in this file.

---

## [8.13.1] - 2025-10-11

### 🐛 Bug Fixes
- **Fixed Chart Time Period Selector**:
  - Charts now correctly display the full selected time range
  - "Past 24 Hours" shows full 24 hours backward from current time (e.g., 11:51 AM yesterday to 11:51 AM today)
  - Previously only showed from midnight to current time
  - Fix: Re-fetches historical data from server when time period changes
  - Properly filters data to exact time range before displaying
  - Applies to all time periods (1h, 12h, 24h, 48h, 7 days, 1 month, 1 year)

### 🔧 Technical Improvements
- `changeTimePeriod()` now fetches `/data/history` on each period change
- Filters historical data to selected time range before chart update
- Reduces data points intelligently for performance
- Updates chart x-axis min/max to exact time boundaries

---

## [8.13.0] - 2025-10-11

### 🎯 Major Features
- **Peak Discharge Monitoring**: Intelligent battery discharge detection during optimal solar production hours
  - Automatically adjusted seasonal peak hours based on solar position and day length
  - **Summer (Jun-Aug)**: 10:00 AM - 3:00 PM (5 hours)
  - **Spring/Fall (Mar-May, Sep-Oct)**: 9:45 AM - 2:15 PM (4.5 hours)  
  - **Winter (Nov-Feb)**: 10:00 AM - 2:00 PM (4 hours)
  - Email alerts when battery discharges for more than 30 minutes during peak hours
  - Helps identify dirty panels, inverter issues, shading problems, or excessive loads

### ✨ Enhancements
- **Wider Settings Modal**:
  - Increased width from 500px to max(700px, 70vw)
  - 40% wider minimum, or 70% of viewport width
  - Much better use of screen space for all settings sections
  - Fully responsive on mobile devices

- **Floating Save Button**:
  - "💾 Save All Settings" button floats at bottom right corner
  - Always visible regardless of scroll position
  - Beautiful gradient design with hover effects
  - Makes it easy to save settings from any section

- **Power Balance Calculation** (Restored from v8.12):
  - Fixed calculation: Total Power Input - Load Power
  - Total Power Input = Solar + External Charger (only when IFTTT triggered ON)
  - Charger power only counted when `chargerState.isOn` AND charging
  - Simplified status text: "Charging" or "Discharging"
  - Shows charger wattage detail when IFTTT charger is active (e.g., "⚡ Charger: 658W")

- **Simplified UI**:
  - Removed custom SOC test field (unnecessary complexity)
  - Removed redundant charger test status div
  - Cleaner test sections with just essential controls

### 🔧 Technical Improvements
- **Template Literal Safety**:
  - Complete rebuild using ONLY string concatenation in email messages
  - No nested template literals that could cause syntax errors
  - All dynamic content uses `+` operator for concatenation
  - Prevents "Invalid or unexpected token" JavaScript errors

- **New Functions**:
  - `getSeasonalPeakHours()` - Calculates peak hours for current date/season
  - `isWithinPeakHours()` - Checks if current time is within peak hours
  - `monitorPeakDischarge()` - Monitors battery discharge and triggers alerts
  - `formatHour()` - Formats decimal hours to 12-hour AM/PM format

- **State Management**:
  - Added `peakDischargeState` object for tracking discharge periods
  - Tracks discharge status, start time, alert sent flag
  - Prevents duplicate alerts during same discharge period

- **Configuration**:
  - Added `peakDischargeAlert` section to alert settings
  - Configurable alert duration (default: 30 minutes)
  - Enable/disable toggle in settings modal

- **Integration**:
  - Integrated with MQTT handler for `battery_power` topic
  - Uses existing weather data for contextual diagnostics
  - Leverages cached MQTT data for system status reporting
  - Added `chargerState` to `/data` API endpoint

### 📊 Alert Features
Peak discharge alert email provides:
- ⏰ Discharge timing (start time, duration)
- ☀️ Current seasonal peak hours
- 📊 Real-time system metrics (solar, load, battery, SOC)
- 💡 Intelligent diagnostics based on actual conditions:
  - Low solar production warnings
  - High load consumption alerts
  - Weather impact analysis (cloud cover, irradiance)
- 🔍 Recommended troubleshooting actions

### 🐛 Bug Fixes
- **Fixed Template Literal Syntax Errors**:
  - Removed nested backticks that broke JavaScript parsing
  - Converted all email messages to use string concatenation
  - Resolved "Invalid or unexpected token" errors
  - Fixed buttons not working (theme toggle, settings, logout)
  - Fixed charts not loading

- **Fixed Power Balance Display**:
  - Correctly calculates total power input from all sources
  - Only counts charger power when IFTTT has triggered it ON
  - Prevents incorrect positive numbers when charger is OFF
  - Shows accurate +/- balance values

### 🎨 UI/UX Improvements
- Settings modal much more spacious and easier to navigate
- Floating save button always accessible
- Cleaner test sections without unnecessary fields
- Peak discharge section with educational seasonal hours display
- Better visual feedback for power balance with charger status

### 🌍 Location-Specific Features
- Optimized for Queen Creek, AZ (33.2487°N, -111.6343°W)
- No Daylight Saving Time adjustments (Arizona-specific)
- Solar noon calculations accurate for local latitude
- Can be adapted for other locations by updating `WEATHER_LAT` and `WEATHER_LON`

---

## [8.12.0] - 2025-10-11

### 🎯 Major Features
- **Test Override System**: Test alert buttons now completely override ALL settings and restrictions
  - Bypasses charger control thresholds (75%/90%)
  - Bypasses 5-minute cooldown period
  - Uses simplified test threshold of 80% (below = ON, above = OFF)
  - Forces IFTTT webhook calls regardless of current state

### ✨ Enhancements
- **Power Balance Display**:
  - Fixed calculation to accurately reflect power sources
  - Simplified status text: "Charging" or "Discharging"
  - Added charger power display when IFTTT charger is active

- **Manual Charger Control**:
  - Removed redundant "Force Reset & Turn OFF" button
  - Clarified that manual ON/OFF buttons override all restrictions
  - Streamlined UI

### 🐛 Bug Fixes
- Fixed power balance calculation bug
- Fixed test recovery button functionality
- Fixed email notification async/await issues

---

## [8.11.1] - 2025-10-11

### 🐛 Critical Bug Fixes
- **Fixed Async/Await Email Notifications**: 
  - Resolved "fire and forget" pattern causing emails not to be sent
  - Made `checkBatteryAlerts()` function async
  - Made MQTT message handler async
  - Properly awaited all `sendEmailAlert()` calls

---

## Version History

- **v8.13.0**: Peak discharge monitoring, wider modal, floating save button, power balance fixes
- **v8.12.0**: Test override system, power balance improvements
- **v8.11.1**: Critical email notification bug fixes
- **v8.11.0**: Full-featured dashboard with IFTTT integration

---

**Last Updated**: October 11, 2025

