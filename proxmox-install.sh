#!/bin/bash

# ═══════════════════════════════════════════════════════════════════════════
# PROXMOX 9.0 SOLARASSISTANT INSTALLATION SCRIPT
# ═══════════════════════════════════════════════════════════════════════════
# 
# This script automates the deployment of the SolarAssistant Monitor
# Node.js application in an LXC container on Proxmox VE 9.0.x
#
# Features:
# - Interactive configuration with sensible defaults
# - LXC container creation with Debian 12 (Bookworm)
# - Node.js 18.x LTS installation
# - PM2 process management
# - Automatic startup configuration
# - Comprehensive error handling and logging
#
# Usage:
#   ./proxmox-install.sh                    # Interactive mode (recommended)
#   curl -fsSL https://raw.githubusercontent.com/crowninternet/solarassistant/master/proxmox-install.sh | bash
#
# ═══════════════════════════════════════════════════════════════════════════

set -e  # Exit on any error

# ═══════════════════════════════════════════════════════════════════════════
# CONFIGURATION & VARIABLES
# ═══════════════════════════════════════════════════════════════════════════

# Script metadata
SCRIPT_VERSION="1.0.0"
SCRIPT_NAME="Proxmox SolarAssistant Installer"
LOG_FILE="/root/solarassistant-install.log"

# Default values (can be overridden by environment variables)
DEFAULT_CTID=100
DEFAULT_HOSTNAME="solarassistant"
DEFAULT_MEMORY=2048
DEFAULT_CORES=2
DEFAULT_BRIDGE="vmbr0"
DEFAULT_MQTT_IP="localhost"
DEFAULT_WEATHER_LAT="33.2487"  # Queen Creek, AZ (from app.js)
DEFAULT_WEATHER_LON="-111.6343"
DEFAULT_PORT="3434"
# App will be deployed from GitHub, no local directory needed

# Template and container settings
DEBIAN_TEMPLATE="debian-12-standard_12.12-1_amd64.tar.zst"
CONTAINER_ROOTFS="local-lvm:8"
APP_INSTALL_DIR="/opt/solarassistant"

# ═══════════════════════════════════════════════════════════════════════════
# COLOR OUTPUT FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
NC='\033[0m' # No Color

# Output functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1" | tee -a "$LOG_FILE"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1" | tee -a "$LOG_FILE"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1" | tee -a "$LOG_FILE"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" | tee -a "$LOG_FILE"
}

log_step() {
    echo -e "${PURPLE}[STEP]${NC} $1" | tee -a "$LOG_FILE"
}

# ═══════════════════════════════════════════════════════════════════════════
# UTILITY FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════

# Check if running as root
check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This script must be run as root"
        exit 1
    fi
}

# Check Proxmox version compatibility
check_proxmox_version() {
    log_info "Checking Proxmox VE version..."
    
    if ! command -v pveversion &> /dev/null; then
        log_error "This script must be run on a Proxmox VE host"
        exit 1
    fi
    
    local pve_version=$(pveversion | grep -oE '[0-9]+\.[0-9]+' | head -1)
    local major_version=$(echo "$pve_version" | cut -d. -f1)
    
    if [[ $major_version -lt 9 ]]; then
        log_error "This script requires Proxmox VE 9.0 or higher. Current version: $pve_version"
        exit 1
    fi
    
    log_success "Proxmox VE $pve_version detected - compatible"
}

# Check if template exists
check_template() {
    log_info "Checking for Debian 12 template..."
    
    # Check if template exists in local storage
    if ! pveam list local | grep -q "$DEBIAN_TEMPLATE"; then
        log_warning "Debian 12 template not found. Downloading..."
        
        # Try to download the template
        if ! pveam download local "$DEBIAN_TEMPLATE"; then
            log_error "Failed to download template. Please check available templates with: pveam available"
            log_info "Available templates:"
            pveam available | grep debian
            exit 1
        fi
        
        log_success "Template downloaded successfully"
    else
        log_success "Debian 12 template found"
    fi
}

# Check if container ID is available
check_ctid_available() {
    local ctid=$1
    if pct list | grep -q "^$ctid "; then
        return 1  # Not available
    else
        return 0  # Available
    fi
}

# Get container IP address
get_container_ip() {
    local ctid=$1
    local ip=$(pct exec "$ctid" -- ip route get 1.1.1.1 | grep -oP 'src \K\S+' | head -1)
    echo "$ip"
}

# ═══════════════════════════════════════════════════════════════════════════
# INTERACTIVE PROMPT FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════

# Prompt for container ID
prompt_ctid() {
    local ctid=${CTID:-$DEFAULT_CTID}
    
    while true; do
        read -p "Container ID [$ctid]: " input_ctid
        ctid=${input_ctid:-$ctid}
        
        if [[ ! "$ctid" =~ ^[0-9]+$ ]] || [[ $ctid -lt 100 ]] || [[ $ctid -gt 999999999 ]]; then
            log_error "Container ID must be a number between 100 and 999999999"
            continue
        fi
        
        if ! check_ctid_available "$ctid"; then
            log_error "Container ID $ctid is already in use"
            continue
        fi
        
        break
    done
    
    echo "$ctid"
}

# Prompt for hostname
prompt_hostname() {
    local hostname=${HOSTNAME:-$DEFAULT_HOSTNAME}
    
    while true; do
        read -p "Container hostname [$hostname]: " input_hostname
        hostname=${input_hostname:-$hostname}
        
        if [[ ! "$hostname" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$ ]] && [[ ! "$hostname" =~ ^[a-zA-Z0-9]$ ]]; then
            log_error "Hostname must contain only letters, numbers, and hyphens (not start/end with hyphen)"
            continue
        fi
        
        break
    done
    
    echo "$hostname"
}

# Prompt for memory allocation
prompt_memory() {
    local memory=${MEMORY:-$DEFAULT_MEMORY}
    
    while true; do
        read -p "Memory allocation in MB [$memory]: " input_memory
        memory=${input_memory:-$memory}
        
        if [[ ! "$memory" =~ ^[0-9]+$ ]] || [[ $memory -lt 512 ]]; then
            log_error "Memory must be a number >= 512 MB"
            continue
        fi
        
        break
    done
    
    echo "$memory"
}

# Prompt for CPU cores
prompt_cores() {
    local cores=${CORES:-$DEFAULT_CORES}
    
    while true; do
        read -p "CPU cores [$cores]: " input_cores
        cores=${input_cores:-$cores}
        
        if [[ ! "$cores" =~ ^[0-9]+$ ]] || [[ $cores -lt 1 ]]; then
            log_error "CPU cores must be a number >= 1"
            continue
        fi
        
        break
    done
    
    echo "$cores"
}

# Prompt for MQTT broker IP
prompt_mqtt_ip() {
    local mqtt_ip=${MQTT_IP:-$DEFAULT_MQTT_IP}
    
    while true; do
        read -p "MQTT broker IP address [$mqtt_ip]: " input_mqtt_ip
        mqtt_ip=${input_mqtt_ip:-$mqtt_ip}
        
        if [[ ! "$mqtt_ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] && [[ "$mqtt_ip" != "localhost" ]]; then
            log_error "Please enter a valid IP address or 'localhost'"
            continue
        fi
        
        break
    done
    
    echo "$mqtt_ip"
}

# Prompt for weather coordinates
prompt_weather_coords() {
    local lat=${WEATHER_LAT:-$DEFAULT_WEATHER_LAT}
    local lon=${WEATHER_LON:-$DEFAULT_WEATHER_LON}
    
    while true; do
        read -p "Weather latitude [$lat]: " input_lat
        lat=${input_lat:-$lat}
        
        if [[ ! "$lat" =~ ^-?[0-9]+\.?[0-9]*$ ]] || (( $(echo "$lat < -90 || $lat > 90" | bc -l) )); then
            log_error "Latitude must be a number between -90 and 90"
            continue
        fi
        
        break
    done
    
    while true; do
        read -p "Weather longitude [$lon]: " input_lon
        lon=${input_lon:-$lon}
        
        if [[ ! "$lon" =~ ^-?[0-9]+\.?[0-9]*$ ]] || (( $(echo "$lon < -180 || $lon > 180" | bc -l) )); then
            log_error "Longitude must be a number between -180 and 180"
            continue
        fi
        
        break
    done
    
    echo "$lat $lon"
}


# ═══════════════════════════════════════════════════════════════════════════
# CONTAINER CREATION FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════

# Create LXC container
create_container() {
    local ctid=$1
    local hostname=$2
    local memory=$3
    local cores=$4
    
    log_step "Creating LXC container $ctid..."
    
    pct create "$ctid" "local:vztmpl/$DEBIAN_TEMPLATE" \
        --hostname "$hostname" \
        --memory "$memory" \
        --swap 512 \
        --cores "$cores" \
        --rootfs "$CONTAINER_ROOTFS" \
        --net0 "name=eth0,bridge=$DEFAULT_BRIDGE,ip=dhcp" \
        --unprivileged 1 \
        --features "nesting=1" \
        --onboot 1 \
        --start 1
    
    log_success "Container $ctid created and started"
}

# Wait for container to be ready
wait_for_container() {
    local ctid=$1
    local max_attempts=30
    local attempt=1
    
    log_info "Waiting for container to be ready..."
    
    while [[ $attempt -le $max_attempts ]]; do
        if pct exec "$ctid" -- true 2>/dev/null; then
            log_success "Container is ready"
            return 0
        fi
        
        log_info "Attempt $attempt/$max_attempts - waiting..."
        sleep 2
        ((attempt++))
    done
    
    log_error "Container failed to become ready after $max_attempts attempts"
    exit 1
}

# ═══════════════════════════════════════════════════════════════════════════
# DEPENDENCY INSTALLATION FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════

# Update system packages
update_system() {
    local ctid=$1
    
    log_step "Updating system packages..."
    
    pct exec "$ctid" -- bash -c "
        apt update -y &&
        apt upgrade -y &&
        apt install -y curl wget gnupg2 software-properties-common apt-transport-https ca-certificates
    "
    
    log_success "System packages updated"
}

# Install Node.js 18.x LTS
install_nodejs() {
    local ctid=$1
    
    log_step "Installing Node.js 18.x LTS..."
    
    pct exec "$ctid" -- bash -c "
        curl -fsSL https://deb.nodesource.com/setup_18.x | bash - &&
        apt-get install -y nodejs
    "
    
    # Verify installation
    local node_version=$(pct exec "$ctid" -- node --version)
    local npm_version=$(pct exec "$ctid" -- npm --version)
    
    log_success "Node.js $node_version and npm $npm_version installed"
}

# Install PM2 globally
install_pm2() {
    local ctid=$1
    
    log_step "Installing PM2 process manager..."
    
    pct exec "$ctid" -- npm install -g pm2
    
    log_success "PM2 installed globally"
}

# ═══════════════════════════════════════════════════════════════════════════
# APPLICATION DEPLOYMENT FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════

# Create application directory
create_app_directory() {
    local ctid=$1
    
    log_step "Creating application directory..."
    
    pct exec "$ctid" -- bash -c "
        mkdir -p $APP_INSTALL_DIR &&
        chown -R 1000:1000 $APP_INSTALL_DIR
    "
    
    log_success "Application directory created"
}

# Download application from GitHub
download_app_from_github() {
    local ctid=$1
    
    log_step "Downloading SolarAssistant application from GitHub..."
    
    pct exec "$ctid" -- bash -c "
        cd $APP_INSTALL_DIR &&
        curl -fsSL https://github.com/crowninternet/solarassistant/archive/master.tar.gz | tar -xz --strip-components=1 &&
        rm -rf backups node_modules
    "
    
    log_success "Application downloaded from GitHub"
}

# Install application dependencies
install_app_dependencies() {
    local ctid=$1
    
    log_step "Installing application dependencies..."
    
    pct exec "$ctid" -- bash -c "
        cd $APP_INSTALL_DIR &&
        npm install --production
    "
    
    log_success "Application dependencies installed"
}

# Create environment file
create_env_file() {
    local ctid=$1
    local mqtt_ip=$2
    local lat=$3
    local lon=$4
    local port=$5
    
    log_step "Creating environment configuration..."
    
    pct exec "$ctid" -- bash -c "cat > $APP_INSTALL_DIR/.env << EOF
PORT=$port
MQTT_BROKER=mqtt://$mqtt_ip:1883
WEATHER_LAT=$lat
WEATHER_LON=$lon
NODE_ENV=production
EOF"
    
    log_success "Environment file created"
}

# ═══════════════════════════════════════════════════════════════════════════
# PM2 CONFIGURATION FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════

# Configure PM2
configure_pm2() {
    local ctid=$1
    
    log_step "Configuring PM2 process manager..."
    
    pct exec "$ctid" -- bash -c "
        cd $APP_INSTALL_DIR &&
        pm2 start app.js --name solarassistant --log-date-format 'YYYY-MM-DD HH:mm:ss Z' &&
        pm2 startup systemd -u root --hp /root &&
        pm2 save
    "
    
    log_success "PM2 configured and application started"
}

# ═══════════════════════════════════════════════════════════════════════════
# CLEANUP AND ERROR HANDLING
# ═══════════════════════════════════════════════════════════════════════════

# Cleanup function
cleanup() {
    local exit_code=$?
    
    if [[ $exit_code -ne 0 ]]; then
        log_error "Installation failed with exit code $exit_code"
        
        # Attempt to clean up container if it was created
        if [[ -n "${CREATED_CTID:-}" ]]; then
            log_warning "Cleaning up container $CREATED_CTID..."
            pct stop "$CREATED_CTID" 2>/dev/null || true
            pct destroy "$CREATED_CTID" 2>/dev/null || true
        fi
    fi
    
    exit $exit_code
}

# Set up error handling
trap cleanup EXIT

# ═══════════════════════════════════════════════════════════════════════════
# MAIN INSTALLATION FUNCTION
# ═══════════════════════════════════════════════════════════════════════════

main() {
    # Initialize log file
    echo "=== SolarAssistant Installation Log - $(date) ===" > "$LOG_FILE"
    
    # Display banner
    echo -e "${CYAN}"
    echo "╔══════════════════════════════════════════════════════════════════════════╗"
    echo "║                    PROXMOX SOLARASSISTANT INSTALLER                     ║"
    echo "║                              Version $SCRIPT_VERSION                              ║"
    echo "╚══════════════════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    
    log_info "Starting SolarAssistant installation on Proxmox VE"
    
    # Pre-installation checks
    check_root
    check_proxmox_version
    check_template
    
    # Check if running interactively
    if [[ -t 0 ]]; then
        # Interactive configuration
        echo -e "\n${WHITE}Container Configuration${NC}"
        echo "══════════════════════════════════════════════════════════════════════════"
        
        CTID=$(prompt_ctid)
        HOSTNAME=$(prompt_hostname)
        MEMORY=$(prompt_memory)
        CORES=$(prompt_cores)
        
        echo -e "\n${WHITE}Application Configuration${NC}"
        echo "══════════════════════════════════════════════════════════════════════════"
        
        MQTT_IP=$(prompt_mqtt_ip)
        read -r WEATHER_LAT WEATHER_LON <<< "$(prompt_weather_coords)"
    else
        # Non-interactive mode - use defaults and show guidance
        log_info "Non-interactive mode detected (curl | bash)"
        echo -e "\n${YELLOW}══════════════════════════════════════════════════════════════════════════${NC}"
        echo -e "${YELLOW}                    NON-INTERACTIVE MODE DETECTED${NC}"
        echo -e "${YELLOW}══════════════════════════════════════════════════════════════════════════${NC}"
        echo -e "\n${WHITE}Using default configuration:${NC}"
        echo "  Container ID: $DEFAULT_CTID"
        echo "  Hostname: $DEFAULT_HOSTNAME"
        echo "  Memory: ${DEFAULT_MEMORY}MB"
        echo "  CPU Cores: $DEFAULT_CORES"
        echo "  MQTT Broker: $DEFAULT_MQTT_IP"
        echo "  Weather Coordinates: $DEFAULT_WEATHER_LAT, $DEFAULT_WEATHER_LON"
        echo -e "\n${CYAN}To customize these settings, download and run interactively:${NC}"
        echo "  wget https://raw.githubusercontent.com/crowninternet/solarassistant/master/proxmox-install.sh"
        echo "  chmod +x proxmox-install.sh"
        echo "  ./proxmox-install.sh"
        echo -e "\n${GREEN}Proceeding with default configuration...${NC}"
        echo -e "${YELLOW}══════════════════════════════════════════════════════════════════════════${NC}\n"
        
        # Use defaults
        CTID=$DEFAULT_CTID
        HOSTNAME=$DEFAULT_HOSTNAME
        MEMORY=$DEFAULT_MEMORY
        CORES=$DEFAULT_CORES
        MQTT_IP=$DEFAULT_MQTT_IP
        WEATHER_LAT=$DEFAULT_WEATHER_LAT
        WEATHER_LON=$DEFAULT_WEATHER_LON
    fi
    
    # Store CTID for cleanup
    CREATED_CTID=$CTID
    
    # Display configuration summary
    echo -e "\n${WHITE}Installation Summary${NC}"
    echo "══════════════════════════════════════════════════════════════════════════"
    echo "Container ID: $CTID"
    echo "Hostname: $HOSTNAME"
    echo "Memory: ${MEMORY}MB"
    echo "CPU Cores: $CORES"
    echo "MQTT Broker: $MQTT_IP"
    echo "Weather Coordinates: $WEATHER_LAT, $WEATHER_LON"
    echo "App Source: GitHub Repository"
    echo "══════════════════════════════════════════════════════════════════════════"
    
    if [[ -t 0 ]]; then
        read -p "Proceed with installation? [Y/n]: " confirm
        if [[ "$confirm" =~ ^[Nn]$ ]]; then
            log_info "Installation cancelled by user"
            exit 0
        fi
    else
        log_info "Non-interactive mode - proceeding with installation automatically"
    fi
    
    # Container creation and setup
    create_container "$CTID" "$HOSTNAME" "$MEMORY" "$CORES"
    wait_for_container "$CTID"
    
    # System setup
    update_system "$CTID"
    install_nodejs "$CTID"
    install_pm2 "$CTID"
    
    # Application deployment
    create_app_directory "$CTID"
    download_app_from_github "$CTID"
    install_app_dependencies "$CTID"
    create_env_file "$CTID" "$MQTT_IP" "$WEATHER_LAT" "$WEATHER_LON" "$DEFAULT_PORT"
    
    # PM2 configuration
    configure_pm2 "$CTID"
    
    # Get container IP
    local container_ip=$(get_container_ip "$CTID")
    
    # Success message
    echo -e "\n${GREEN}╔══════════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                        INSTALLATION COMPLETE!                        ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════════════════════════╝${NC}"
    
    echo -e "\n${WHITE}Container Information:${NC}"
    echo "  Container ID: $CTID"
    echo "  Hostname: $HOSTNAME"
    echo "  IP Address: $container_ip"
    echo "  Status: Running"
    
    echo -e "\n${WHITE}Application Access:${NC}"
    echo "  Dashboard URL: http://$container_ip:$DEFAULT_PORT"
    echo "  API Endpoint: http://$container_ip:$DEFAULT_PORT/data"
    
    echo -e "\n${WHITE}Management Commands:${NC}"
    echo "  View logs: pct exec $CTID -- pm2 logs solarassistant"
    echo "  Restart app: pct exec $CTID -- pm2 restart solarassistant"
    echo "  Stop app: pct exec $CTID -- pm2 stop solarassistant"
    echo "  App status: pct exec $CTID -- pm2 status"
    
    echo -e "\n${WHITE}Container Management:${NC}"
    echo "  Stop container: pct stop $CTID"
    echo "  Start container: pct start $CTID"
    echo "  Console access: pct enter $CTID"
    
    # Create installation summary file
    cat > "/root/solarassistant-install.log" << EOF
SolarAssistant Installation Summary
==================================
Installation Date: $(date)
Container ID: $CTID
Hostname: $HOSTNAME
IP Address: $container_ip
Memory: ${MEMORY}MB
CPU Cores: $CORES
MQTT Broker: $MQTT_IP
Weather Coordinates: $WEATHER_LAT, $WEATHER_LON
Application Directory: $APP_INSTALL_DIR
Dashboard URL: http://$container_ip:$DEFAULT_PORT

Management Commands:
- View logs: pct exec $CTID -- pm2 logs solarassistant
- Restart app: pct exec $CTID -- pm2 restart solarassistant
- Stop app: pct exec $CTID -- pm2 stop solarassistant
- App status: pct exec $CTID -- pm2 status

Container Management:
- Stop container: pct stop $CTID
- Start container: pct start $CTID
- Console access: pct enter $CTID
EOF
    
    log_success "Installation completed successfully!"
    log_info "Installation summary saved to $LOG_FILE"
    
    # Clear cleanup flag
    unset CREATED_CTID
}

# ═══════════════════════════════════════════════════════════════════════════
# SCRIPT EXECUTION
# ═══════════════════════════════════════════════════════════════════════════

# Run main function
main "$@"
