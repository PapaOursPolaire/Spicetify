#!/bin/bash

# Script d'installation de Spotify, Spicetify et Marketplace
# Compatible avec les distributions basées sur Debian, Fedora, Arch et openSUSE

set -e 

# Couleurs pour l'affichage
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Fonction d'affichage
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCÈS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[ATTENTION]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERREUR]${NC} $1"
}

# Vérifier si on est root
check_root() {
    if [[ $EUID -eq 0 ]]; then
        print_warning "Ce script ne doit pas être exécuté en tant que root"
        exit 1
    fi
}

# Détection de la distribution
detect_distro() {
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        DISTRO=$ID
        VERSION=$VERSION_ID
    elif [[ -f /etc/redhat-release ]]; then
        DISTRO="rhel"
    elif [[ -f /etc/arch-release ]]; then
        DISTRO="arch"
    else
        print_error "Distribution non supportée ou non détectée"
        exit 1
    fi
}

# Vérifier si Spotify est installé
check_spotify_installed() {
    if command -v spotify &> /dev/null || \
        [[ -f /usr/bin/spotify ]] || \
        [[ -f /usr/local/bin/spotify ]] || \
        [[ -f /opt/spotify/spotify ]]; then
        return 0
    else
        return 1
    fi
}

# Installation de Spotify selon la distribution
install_spotify() {
    case $DISTRO in
        debian|ubuntu|pop|linuxmint)
            print_status "Installation de Spotify pour Debian/Ubuntu..."
            # Ajouter le repository Spotify
            curl -sS https://download.spotify.com/debian/pubkey_7A3A762FAFD4A51F.gpg | sudo gpg --dearmor --yes -o /etc/apt/trusted.gpg.d/spotify.gpg
            echo "deb http://repository.spotify.com stable non-free" | sudo tee /etc/apt/sources.list.d/spotify.list
            sudo apt update
            sudo apt install -y spotify-client
            ;;
        
        fedora|rhel|centos)
            print_status "Installation de Spotify pour Fedora/RHEL/CentOS..."
            # Ajouter le repository RPM Fusion
            if ! rpm -q rpmfusion-free-release; then
                sudo dnf install -y https://download1.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm
            fi
            sudo dnf install -y spotify-client
            ;;
        
        arch|manjaro)
            print_status "Installation de Spotify pour Arch/Manjaro..."
            if command -v yay &> /dev/null; then
                yay -S --noconfirm spotify
            elif command -v paru &> /dev/null; then
                paru -S --noconfirm spotify
            else
                # Utiliser le AUR via makepkg
                git clone https://aur.archlinux.org/spotify.git /tmp/spotify-aur
                cd /tmp/spotify-aur
                makepkg -si --noconfirm
                cd -
            fi
            ;;
        
        opensuse|opensuse-leap|opensuse-tumbleweed)
            print_status "Installation de Spotify pour openSUSE..."
            sudo zypper addrepo https://download.opensuse.org/repositories/home:/crackpk/openSUSE_Tumbleweed/ home:crackpk
            sudo zypper refresh
            sudo zypper install -y spotify-client
            ;;
        
        *)
            print_error "Distribution non supportée: $DISTRO"
            print_warning "Veuillez installer Spotify manuellement depuis https://www.spotify.com"
            return 1
            ;;
    esac
    
    if check_spotify_installed; then
        print_success "Spotify installé avec succès"
        return 0
    else
        print_error "Échec de l'installation de Spotify"
        return 1
    fi
}

# Installation de Spicetify
install_spicetify() {
    print_status "Installation de Spicetify..."
    
    # Vérifier si Spicetify est déjà installé
    if command -v spicetify &> /dev/null; then
        print_status "Spicetify est déjà installé"
        return 0
    fi
    
    # Télécharger et installer Spicetify
    curl -fsSL https://raw.githubusercontent.com/spicetify/spicetify-cli/master/install.sh | sh
    
    # Configurer Spicetify
    if command -v spicetify &> /dev/null; then
        spicetify backup apply
        spicetify config custom_apps marketplace
        spicetify apply
        print_success "Spicetify installé et configuré"
    else
        print_error "Échec de l'installation de Spicetify"
        return 1
    fi
}

# Installation du Marketplace pour Spicetify
install_marketplace() {
    print_status "Installation du Marketplace Spicetify..."
    
    # Vérifier si le marketplace est déjà installé
    if [[ -d "$HOME/.spicetify/marketplace" ]]; then
        print_status "Marketplace déjà installé"
        return 0
    fi
    
    # Cloner le repository marketplace
    git clone https://github.com/spicetify/spicetify-marketplace.git "$HOME/.spicetify/marketplace"
    
    # Configurer le marketplace
    if [[ -d "$HOME/.spicetify/marketplace" ]]; then
        cd "$HOME/.spicetify/marketplace"
        chmod +x scripts/*
        ./install.sh
        cd -
        print_success "Marketplace installé"
    else
        print_error "Échec de l'installation du Marketplace"
        return 1
    fi
}

# Fonction principale
main() {
    print_status "Début de l'installation..."
    
    check_root
    detect_distro
    
    print_status "Distribution détectée: $DISTRO"
    
    # Vérifier et installer Spotify
    if check_spotify_installed; then
        print_status "Spotify est déjà installé"
    else
        print_status "Installation de Spotify..."
        install_spotify
    fi
    
    # Installer Spicetify
    install_spicetify
    
    # Installer le Marketplace
    install_marketplace
    
    # Configuration finale
    print_status "Configuration finale..."
    spicetify backup apply
    spicetify apply
    
    print_success "Installation terminée avec succès !"
    print_warning "Redémarrez Spotify pour voir les changements"
    print_status "Pour accéder au marketplace: Ouvrez Spotify -> Spicetify -> Marketplace"
}

# Gestion des erreurs
trap 'print_error "Script interrompu"; exit 1' INT TERM

# Exécution du script
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi