#!/bin/bash

# Script d'installation de Spotify, Spicetify et Marketplace
# Compatible avec les distributions basées sur Debian, Fedora, Arch et openSUSE
# Version améliorée avec détection automatique des clés et gestion d'erreurs avancée

set -e 

# Couleurs pour l'affichage
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Variables globales
SPOTIFY_REPO="http://repository.spotify.com stable non-free"
LOG_FILE="$HOME/.spicetify-install.log"
BACKUP_DIR="$HOME/.spicetify-backup-$(date +%Y%m%d-%H%M%S)"

# Liste des clés GPG Spotify connues (de la plus récente à la plus ancienne)
SPOTIFY_KEYS=(
    "https://download.spotify.com/debian/pubkey_C85668DF69375001.gpg"  # 2024-2025
    "https://download.spotify.com/debian/pubkey_6224F9941A8AA6D1.gpg"  # 2023-2024
    "https://download.spotify.com/debian/pubkey_7A3A762FAFD4A51F.gpg"  # Ancienne
)

# Fonction d'affichage
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
    echo "[INFO] $1" >> "$LOG_FILE"
}

print_success() {
    echo -e "${GREEN}[SUCCÈS]${NC} $1"
    echo "[SUCCÈS] $1" >> "$LOG_FILE"
}

print_warning() {
    echo -e "${YELLOW}[ATTENTION]${NC} $1"
    echo "[ATTENTION] $1" >> "$LOG_FILE"
}

print_error() {
    echo -e "${RED}[ERREUR]${NC} $1"
    echo "[ERREUR] $1" >> "$LOG_FILE"
}

print_debug() {
    if [[ "${DEBUG}" == "1" ]]; then
        echo -e "${CYAN}[DEBUG]${NC} $1"
    fi
    echo "[DEBUG] $1" >> "$LOG_FILE"
}

# Initialisation du fichier log
init_log() {
    echo "=== Installation Spicetify - $(date) ===" > "$LOG_FILE"
}

# Vérifier si on est root
check_root() {
    if [[ $EUID -eq 0 ]]; then
        print_warning "Ce script ne doit pas être exécuté en tant que root"
        exit 1
    fi
}

# Vérifier les dépendances requises
check_dependencies() {
    print_status "Vérification des dépendances..."
    local missing_deps=()
    
    local deps=("curl" "git")
    
    for dep in "${deps[@]}"; do
        if ! command -v "$dep" &> /dev/null; then
            missing_deps+=("$dep")
        fi
    done
    
    if [[ ${#missing_deps[@]} -gt 0 ]]; then
        print_error "Dépendances manquantes: ${missing_deps[*]}"
        print_status "Installation des dépendances..."
        install_dependencies "${missing_deps[@]}"
    else
        print_success "Toutes les dépendances sont présentes"
    fi
}

# Installer les dépendances manquantes
install_dependencies() {
    local deps=("$@")
    
    case $DISTRO in
        debian|ubuntu|pop|linuxmint)
            sudo apt update
            sudo apt install -y "${deps[@]}"
            ;;
        fedora|rhel|centos)
            sudo dnf install -y "${deps[@]}"
            ;;
        arch|manjaro)
            sudo pacman -S --noconfirm "${deps[@]}"
            ;;
        opensuse|opensuse-leap|opensuse-tumbleweed)
            sudo zypper install -y "${deps[@]}"
            ;;
    esac
}

# Détection de la distribution
detect_distro() {
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        DISTRO=$ID
        VERSION=$VERSION_ID
        print_debug "Distribution: $DISTRO $VERSION"
    elif [[ -f /etc/redhat-release ]]; then
        DISTRO="rhel"
    elif [[ -f /etc/arch-release ]]; then
        DISTRO="arch"
    else
        print_error "Distribution non supportée ou non détectée"
        exit 1
    fi
}

# Récupérer la clé GPG Spotify - essaie toutes les clés connues
get_spotify_key() {
    print_status "Récupération de la clé GPG Spotify..."
    
    local temp_key="/tmp/spotify-key-$.gpg"
    local key_installed=false
    local key_count=0
    
    # Essayer chaque clé dans l'ordre (de la plus récente à la plus ancienne)
    for key_url in "${SPOTIFY_KEYS[@]}"; do
        key_count=$((key_count + 1))
        print_debug "Tentative avec la clé $key_count: $key_url"
        
        if curl -fsSL --max-time 10 "$key_url" -o "$temp_key" 2>/dev/null; then
            # Vérifier que le fichier téléchargé est valide
            if [[ -s "$temp_key" ]]; then
                print_status "Clé $key_count récupérée, installation..."
                
                if sudo gpg --dearmor --yes -o /etc/apt/trusted.gpg.d/spotify.gpg "$temp_key" 2>/dev/null; then
                    key_installed=true
                    print_success "✓ Clé GPG Spotify installée avec succès"
                    
                    # Extraire l'ID de la clé pour info
                    local key_id=$(basename "$key_url" .gpg | sed 's/pubkey_//')
                    print_debug "ID de la clé: $key_id"
                    break
                fi
            fi
        fi
        
        print_debug "Clé $key_count échouée, tentative suivante..."
    done
    
    rm -f "$temp_key"
    
    if [[ "$key_installed" == false ]]; then
        print_error "Échec: Aucune clé GPG n'a pu être installée"
        print_warning "Solutions alternatives:"
        print_warning "  1. Vérifier votre connexion internet"
        print_warning "  2. Essayer manuellement avec:"
        print_warning "     curl -sS https://download.spotify.com/debian/pubkey_C85668DF69375001.gpg | sudo gpg --dearmor --yes -o /etc/apt/trusted.gpg.d/spotify.gpg"
        print_warning "  3. Installer Spotify via Flatpak: flatpak install spotify"
        return 1
    fi
    
    return 0
}

# Vérifier quelle clé GPG est actuellement nécessaire
detect_required_key() {
    print_status "Vérification de la clé GPG requise par le dépôt Spotify..."
    
    # Essayer de récupérer les informations du dépôt
    local release_url="http://repository.spotify.com/dists/stable/InRelease"
    local temp_release="/tmp/spotify-release-$.tmp"
    
    if curl -fsSL --max-time 5 "$release_url" -o "$temp_release" 2>/dev/null; then
        # Extraire les IDs de clés du fichier Release
        local key_ids=$(gpg --list-packets "$temp_release" 2>/dev/null | grep -oP 'keyid [0-9A-F]+' | cut -d' ' -f2)
        
        if [[ -n "$key_ids" ]]; then
            print_debug "Clés détectées dans le dépôt: $key_ids"
        fi
        
        rm -f "$temp_release"
    else
        print_debug "Impossible de détecter automatiquement la clé requise"
    fi
}

# Vérifier si Spotify est installé
check_spotify_installed() {
    if command -v spotify &> /dev/null || \
        [[ -f /usr/bin/spotify ]] || \
        [[ -f /usr/local/bin/spotify ]] || \
        [[ -f /opt/spotify/spotify ]] || \
        [[ -f /var/lib/flatpak/app/com.spotify.Client ]] || \
        [[ -f "$HOME/.local/share/flatpak/app/com.spotify.Client" ]]; then
        return 0
    else
        return 1
    fi
}

# Obtenir la version de Spotify installée
get_spotify_version() {
    if command -v spotify &> /dev/null; then
        spotify --version 2>/dev/null || echo "Version inconnue"
    else
        echo "Non installé"
    fi
}

# Créer une sauvegarde de la configuration existante
backup_existing_config() {
    if [[ -d "$HOME/.spicetify" ]]; then
        print_status "Création d'une sauvegarde de la configuration existante..."
        mkdir -p "$BACKUP_DIR"
        cp -r "$HOME/.spicetify" "$BACKUP_DIR/"
        print_success "Sauvegarde créée dans: $BACKUP_DIR"
    fi
}

# Installation de Spotify selon la distribution
install_spotify() {
    case $DISTRO in
        debian|ubuntu|pop|linuxmint)
            print_status "Installation de Spotify pour Debian/Ubuntu..."
            
            # Récupérer la clé GPG
            if ! get_spotify_key; then
                print_error "Échec de la récupération de la clé GPG"
                return 1
            fi
            
            # Ajouter le repository Spotify
            echo "$SPOTIFY_REPO" | sudo tee /etc/apt/sources.list.d/spotify.list
            
            # Mettre à jour et installer
            sudo apt update
            sudo apt install -y spotify-client
            ;;
        
        fedora|rhel|centos)
            print_status "Installation de Spotify pour Fedora/RHEL/CentOS..."
            
            # Ajouter le repository RPM Fusion si nécessaire
            if ! rpm -q rpmfusion-free-release &>/dev/null; then
                print_status "Installation de RPM Fusion..."
                if [[ "$DISTRO" == "fedora" ]]; then
                    sudo dnf install -y "https://download1.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm"
                else
                    print_warning "Veuillez installer RPM Fusion manuellement pour RHEL/CentOS"
                fi
            fi
            
            sudo dnf install -y spotify-client || sudo dnf install -y lpf-spotify-client
            ;;
        
        arch|manjaro|endeavouros)
            print_status "Installation de Spotify pour Arch/Manjaro..."
            
            # Vérifier quel helper AUR est disponible
            if command -v yay &> /dev/null; then
                print_status "Installation via yay..."
                yay -S --noconfirm spotify
            elif command -v paru &> /dev/null; then
                print_status "Installation via paru..."
                paru -S --noconfirm spotify
            elif command -v trizen &> /dev/null; then
                print_status "Installation via trizen..."
                trizen -S --noconfirm spotify
            else
                print_status "Installation manuelle depuis AUR..."
                # Créer un répertoire temporaire
                local temp_dir="/tmp/spotify-aur-$$"
                git clone https://aur.archlinux.org/spotify.git "$temp_dir"
                cd "$temp_dir"
                makepkg -si --noconfirm
                cd - > /dev/null
                rm -rf "$temp_dir"
            fi
            ;;
        
        opensuse|opensuse-leap|opensuse-tumbleweed)
            print_status "Installation de Spotify pour openSUSE..."
            
            # Déterminer la version d'openSUSE
            local suse_repo=""
            if [[ "$DISTRO" == "opensuse-tumbleweed" ]]; then
                suse_repo="openSUSE_Tumbleweed"
            else
                suse_repo="openSUSE_Leap_$VERSION"
            fi
            
            sudo zypper addrepo -f "https://download.opensuse.org/repositories/home:/crackpk/$suse_repo/" home:crackpk
            sudo zypper refresh
            sudo zypper install -y spotify-client
            ;;
        
        *)
            print_error "Distribution non supportée: $DISTRO"
            print_warning "Veuillez installer Spotify manuellement depuis https://www.spotify.com"
            print_status "Alternatives: Flatpak (flatpak install spotify) ou Snap (snap install spotify)"
            return 1
            ;;
    esac
    
    if check_spotify_installed; then
        print_success "Spotify installé avec succès"
        print_status "Version: $(get_spotify_version)"
        return 0
    else
        print_error "Échec de l'installation de Spotify"
        return 1
    fi
}

# Fermer Spotify si en cours d'exécution
close_spotify() {
    if pgrep -x spotify > /dev/null; then
        print_status "Fermeture de Spotify..."
        killall spotify 2>/dev/null || true
        sleep 2
        print_success "Spotify fermé"
    fi
}

# Installation de Spicetify
install_spicetify() {
    print_status "Installation de Spicetify..."
    
    # Fermer Spotify avant l'installation
    close_spotify
    
    # Vérifier si Spicetify est déjà installé
    if command -v spicetify &> /dev/null; then
        local current_version=$(spicetify -v 2>/dev/null || echo "version inconnue")
        print_status "Spicetify est déjà installé: $current_version"
        
        read -p "Voulez-vous mettre à jour Spicetify ? (o/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[OoYy]$ ]]; then
            return 0
        fi
    fi
    
    # Télécharger et installer Spicetify
    if curl -fsSL https://raw.githubusercontent.com/spicetify/cli/main/install.sh | sh; then
        print_success "Spicetify téléchargé avec succès"
    else
        print_error "Échec du téléchargement de Spicetify"
        return 1
    fi
    
    # Ajouter Spicetify au PATH si nécessaire
    if ! command -v spicetify &> /dev/null; then
        export PATH="$HOME/.spicetify:$PATH"
        
        # Ajouter au .bashrc/.zshrc de façon permanente
        local shell_rc=""
        if [[ -n "$BASH_VERSION" ]]; then
            shell_rc="$HOME/.bashrc"
        elif [[ -n "$ZSH_VERSION" ]]; then
            shell_rc="$HOME/.zshrc"
        fi
        
        if [[ -n "$shell_rc" ]] && ! grep -q ".spicetify" "$shell_rc"; then
            echo 'export PATH="$HOME/.spicetify:$PATH"' >> "$shell_rc"
            print_success "PATH mis à jour dans $shell_rc"
        fi
    fi
    
    # Configurer Spicetify
    if command -v spicetify &> /dev/null; then
        print_status "Configuration de Spicetify..."
        
        # Backup et application initiale
        spicetify backup apply || {
            print_warning "Première application échouée, nouvelle tentative..."
            sleep 2
            spicetify restore backup apply
        }
        
        print_success "Spicetify installé et configuré"
        spicetify -v
    else
        print_error "Échec de l'installation de Spicetify"
        print_warning "Essayez de fermer et rouvrir votre terminal"
        return 1
    fi
}

# Installation du Marketplace pour Spicetify
install_marketplace() {
    print_status "Installation du Marketplace Spicetify..."
    
    local marketplace_dir="$HOME/.config/spicetify/CustomApps/marketplace"
    
    # Vérifier si le marketplace est déjà installé
    if [[ -d "$marketplace_dir" ]]; then
        print_status "Marketplace déjà installé"
        
        read -p "Voulez-vous réinstaller le Marketplace ? (o/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[OoYy]$ ]]; then
            rm -rf "$marketplace_dir"
        else
            return 0
        fi
    fi
    
    # Créer le répertoire CustomApps si nécessaire
    mkdir -p "$(dirname "$marketplace_dir")"
    
    # Cloner le repository marketplace
    if git clone --depth=1 https://github.com/spicetify/marketplace.git "$marketplace_dir"; then
        print_success "Marketplace téléchargé avec succès"
    else
        print_error "Échec du téléchargement du Marketplace"
        return 1
    fi
    
    # Activer le marketplace via Spicetify
    if command -v spicetify &> /dev/null; then
        spicetify config custom_apps marketplace
        spicetify apply
        print_success "Marketplace installé et activé"
    else
        print_error "Spicetify non trouvé"
        return 1
    fi
}

# Appliquer un thème par défaut
apply_default_theme() {
    print_status "Configuration du thème par défaut..."
    
    if command -v spicetify &> /dev/null; then
        # Télécharger les thèmes communautaires
        cd "$(dirname "$(spicetify -c)")"
        git clone --depth=1 https://github.com/spicetify/spicetify-themes.git Themes 2>/dev/null || \
            cd Themes && git pull && cd ..
        
        print_success "Thèmes communautaires disponibles"
        print_status "Vous pouvez changer de thème via: spicetify config current_theme <nom_du_theme>"
    fi
}

# Vérifier l'intégrité de l'installation
verify_installation() {
    print_status "Vérification de l'installation..."
    
    local all_good=true
    
    # Vérifier Spotify
    if check_spotify_installed; then
        print_success "✓ Spotify installé"
    else
        print_error "✗ Spotify non installé"
        all_good=false
    fi
    
    # Vérifier Spicetify
    if command -v spicetify &> /dev/null; then
        print_success "✓ Spicetify installé ($(spicetify -v))"
    else
        print_error "✗ Spicetify non installé"
        all_good=false
    fi
    
    # Vérifier Marketplace
    if [[ -d "$HOME/.config/spicetify/CustomApps/marketplace" ]]; then
        print_success "✓ Marketplace installé"
    else
        print_error "✗ Marketplace non installé"
        all_good=false
    fi
    
    if [[ "$all_good" == true ]]; then
        print_success "Installation complète vérifiée !"
    else
        print_warning "Certains composants n'ont pas été installés correctement"
    fi
}

# Afficher les informations post-installation
show_post_install_info() {
    echo ""
    echo -e "${MAGENTA}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${MAGENTA}║${NC}  ${GREEN}Installation terminée avec succès !${NC}                       ${MAGENTA}║${NC}"
    echo -e "${MAGENTA}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${CYAN}Prochaines étapes:${NC}"
    echo -e "  1. Redémarrez Spotify: ${YELLOW}spotify${NC}"
    echo -e "  2. Accédez au Marketplace: ${YELLOW}Spicetify → Marketplace${NC}"
    echo -e "  3. Personnalisez votre thème: ${YELLOW}spicetify config current_theme <theme>${NC}"
    echo ""
    echo -e "${CYAN}Commandes utiles:${NC}"
    echo -e "  • Mettre à jour Spicetify: ${YELLOW}spicetify upgrade${NC}"
    echo -e "  • Restaurer Spotify: ${YELLOW}spicetify restore${NC}"
    echo -e "  • Appliquer les changements: ${YELLOW}spicetify apply${NC}"
    echo ""
    echo -e "${CYAN}Documentation:${NC}"
    echo -e "  • Spicetify: ${BLUE}https://spicetify.app${NC}"
    echo -e "  • Marketplace: ${BLUE}https://github.com/spicetify/marketplace${NC}"
    echo ""
    
    if [[ -d "$BACKUP_DIR" ]]; then
        echo -e "${CYAN}Sauvegarde créée:${NC} $BACKUP_DIR"
        echo ""
    fi
    
    echo -e "${CYAN}Fichier log:${NC} $LOG_FILE"
    echo ""
}

# Fonction de nettoyage en cas d'erreur
cleanup_on_error() {
    print_error "Une erreur s'est produite"
    
    if [[ -d "$BACKUP_DIR" ]] && [[ -d "$HOME/.spicetify" ]]; then
        read -p "Voulez-vous restaurer la sauvegarde ? (o/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[OoYy]$ ]]; then
            rm -rf "$HOME/.spicetify"
            cp -r "$BACKUP_DIR/.spicetify" "$HOME/"
            print_success "Configuration restaurée"
        fi
    fi
}

# Fonction principale
main() {
    init_log
    
    print_status "Début de l'installation de Spicetify..."
    echo ""
    
    check_root
    detect_distro
    
    print_status "Distribution détectée: $DISTRO $VERSION"
    check_dependencies
    echo ""
    
    # Créer une sauvegarde si nécessaire
    backup_existing_config
    
    # Vérifier et installer Spotify
    if check_spotify_installed; then
        print_status "Spotify est déjà installé ($(get_spotify_version))"
    else
        print_status "Installation de Spotify..."
        if ! install_spotify; then
            print_error "Impossible de continuer sans Spotify"
            exit 1
        fi
    fi
    echo ""
    
    # Installer Spicetify
    if ! install_spicetify; then
        cleanup_on_error
        exit 1
    fi
    echo ""
    
    # Installer le Marketplace
    if ! install_marketplace; then
        print_warning "Marketplace non installé, mais Spicetify fonctionne"
    fi
    echo ""
    
    # Appliquer un thème par défaut (optionnel)
    # apply_default_theme
    # echo ""
    
    # Configuration finale
    print_status "Application de la configuration finale..."
    spicetify backup apply
    print_success "Configuration appliquée"
    echo ""
    
    # Vérifier l'installation
    verify_installation
    
    # Afficher les informations post-installation
    show_post_install_info
}

# Gestion des erreurs
trap 'cleanup_on_error; exit 1' INT TERM ERR

# Gestion des arguments
case "${1:-}" in
    --debug)
        DEBUG=1
        print_status "Mode debug activé"
        main
        ;;
    --help|-h)
        echo "Usage: $0 [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --debug    Active le mode debug"
        echo "  --help     Affiche cette aide"
        echo ""
        exit 0
        ;;
    *)
        main "$@"
        ;;
esac
