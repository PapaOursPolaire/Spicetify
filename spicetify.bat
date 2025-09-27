:: Installateur de Spicetify avec Marketplace
:: Version 61.0 - 19/09/2025
:: Auteur: PapaOursPolaire - user of GitHub

@echo off
chcp 65001 > nul
setlocal EnableDelayedExpansion

title Installation de Spicetify
color 0A

echo     INSTALLATION SPICETIFY + MARKETPLACE

set "SPOTIFY_PATH=%APPDATA%\Spotify\Spotify.exe"
set "SPICETIFY_PATH=%APPDATA%\spicetify\spicetify.exe"
set "SPICETIFY_DIR=%APPDATA%\spicetify"
set "EXTENSIONS_DIR=%APPDATA%\spicetify\Extensions"
set "CUSTOMAPPS_DIR=%APPDATA%\spicetify\CustomApps"
set "MARKETPLACE_DIR=%CUSTOMAPPS_DIR%\marketplace"

echo [INFO] Verification des prerequis...
echo [OK] Pret pour l'installation

if not exist "%SPOTIFY_PATH%" (
    echo [ERREUR] Spotify n'est pas installe !
    echo [INFO] Installez d'abord Spotify depuis https://spotify.com/download
    echo [INFO] Puis relancez ce script.
    pause
    exit /b 1
)

echo [OK] Spotify detecte : %SPOTIFY_PATH%

echo [INFO] Fermeture de Spotify...
taskkill /f /im Spotify.exe >nul 2>&1
timeout /t 2 /nobreak >nul

if exist "%SPICETIFY_PATH%" (
    echo [DETECTE] Spicetify est deja installe.
    set /p "REINSTALL=Voulez-vous REINSTALLER COMPLETEMENT Spicetify ? (o/n): "
    if /i "!REINSTALL!"=="o" (
        echo [INFO] DESINSTALLATION COMPLETE en cours...
        
        echo [INFO] Restauration de Spotify...
        "%SPICETIFY_PATH%" restore >nul 2>&1
        
        echo [INFO] Suppression de tous les fichiers Spicetify...
        if exist "%SPICETIFY_DIR%" (
            rmdir /s /q "%SPICETIFY_DIR%" >nul 2>&1
        )
        
        if exist "%LOCALAPPDATA%\spicetify" (
            rmdir /s /q "%LOCALAPPDATA%\spicetify" >nul 2>&1
        )
        
        echo [OK] Desinstallation terminee !
        timeout /t 1 /nobreak >nul
        
    ) else (
        echo [INFO] Conservation de l'installation existante.
        goto CHECK_MARKETPLACE
    )
)

echo [INFO] Installation de Spicetify...

echo [INFO] Configuration des permissions PowerShell...
powershell -Command "Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force" >nul 2>&1

echo [INFO] Telechargement et installation en cours...
powershell -ExecutionPolicy Bypass -Command "& {try { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://raw.githubusercontent.com/spicetify/cli/main/install.ps1')) } catch { Write-Host 'Erreur installation:' $_.Exception.Message; exit 1 }}"

if !errorlevel! neq 0 (
    echo [WARNING] Installation automatique echouee, tentative alternative...
    
    echo [INFO] Tentative de telechargement manuel...
    set "SPICE_ZIP=%TEMP%\spicetify.zip"
    powershell -ExecutionPolicy Bypass -Command "& {Invoke-WebRequest -Uri 'https://github.com/spicetify/cli/releases/latest/download/spicetify-2.38.4-windows-x64.zip' -OutFile '%SPICE_ZIP%'}"
    
    if exist "%SPICE_ZIP%" (
        echo [INFO] Extraction manuelle...
        if not exist "%APPDATA%\spicetify" mkdir "%APPDATA%\spicetify"
        powershell -ExecutionPolicy Bypass -Command "& {Expand-Archive -Path '%SPICE_ZIP%' -DestinationPath '%APPDATA%\spicetify' -Force}"
        del "%SPICE_ZIP%" >nul 2>&1
        
        set "PATH=%APPDATA%\spicetify;%PATH%"
        
        echo @echo off > "%APPDATA%\spicetify\spicetify.bat"
        echo "%APPDATA%\spicetify\spicetify.exe" %%* >> "%APPDATA%\spicetify\spicetify.bat"
        
        echo [INFO] Installation manuelle terminee
    ) else (
        echo [ERREUR] Impossible de telecharger Spicetify !
        pause
        exit /b 1
    )
)

echo [INFO] Attente de l'installation...
set "WAIT_COUNT=0"
:WAIT_SPICETIFY
timeout /t 2 /nobreak >nul
set /a WAIT_COUNT+=1
if not exist "%SPICETIFY_PATH%" (
    if !WAIT_COUNT! lss 15 goto WAIT_SPICETIFY
)

if exist "%SPICETIFY_PATH%" (
    echo [OK] Spicetify installe avec succes !
) else (
    echo [ERREUR] Installation de Spicetify echouee !
    pause
    exit /b 1
)

echo [INFO] Configuration de Spicetify...
"%SPICETIFY_PATH%" config inject_css 1
"%SPICETIFY_PATH%" config replace_colors 1
"%SPICETIFY_PATH%" config overwrite_assets 1
"%SPICETIFY_PATH%" config inject_theme_js 1

echo [INFO] Sauvegarde et application...
"%SPICETIFY_PATH%" backup apply

if !errorlevel! neq 0 (
    echo [WARNING] Probleme lors de l'application. Nouvelle tentative...
    timeout /t 2 /nobreak >nul
    "%SPICETIFY_PATH%" apply
)

:CHECK_MARKETPLACE
echo [INFO] Verification du Marketplace...

if exist "%MARKETPLACE_DIR%" (
    echo [DETECTE] Marketplace deja installe.
    set /p "REINSTALL_MP=Voulez-vous REINSTALLER le Marketplace ? (o/n): "
    if /i "!REINSTALL_MP!"=="o" (
        echo [INFO] Suppression du Marketplace existant...
        rmdir /s /q "%MARKETPLACE_DIR%" >nul 2>&1
    ) else (
        echo [INFO] Conservation du Marketplace existant.
        goto FINAL_CONFIG
    )
)

echo [INFO] Installation du Marketplace...

if not exist "%CUSTOMAPPS_DIR%" mkdir "%CUSTOMAPPS_DIR%"

echo [INFO] Telechargement du marketplace...
powershell -ExecutionPolicy Bypass -Command "& {try { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://raw.githubusercontent.com/spicetify/marketplace/main/install.ps1')) } catch { Write-Host 'Erreur marketplace:' $_.Exception.Message; exit 1 }}"

timeout /t 5 /nobreak >nul
if exist "%MARKETPLACE_DIR%" (
    echo [OK] Marketplace installe avec succes !
) else (
    echo [WARNING] Installation automatique echouee, tentative manuelle...
    
    set "TEMP_ZIP=%TEMP%\marketplace.zip"
    powershell -Command "& {Invoke-WebRequest -Uri 'https://github.com/spicetify/marketplace/archive/refs/heads/main.zip' -OutFile '%TEMP_ZIP%'}"
    
    if exist "%TEMP_ZIP%" (
        powershell -Command "& {Expand-Archive -Path '%TEMP_ZIP%' -DestinationPath '%TEMP%' -Force}"
        if exist "%TEMP%\marketplace-main" (
            xcopy /e /i /h /y "%TEMP%\marketplace-main" "%MARKETPLACE_DIR%" >nul
            del "%TEMP_ZIP%" >nul 2>&1
            rmdir /s /q "%TEMP%\marketplace-main" >nul 2>&1
            echo [OK] Marketplace installe manuellement !
        ) else (
            echo [ERREUR] Installation du Marketplace echouee !
        )
    ) else (
        echo [ERREUR] Telechargement du Marketplace echoue !
    )
)

:FINAL_CONFIG
echo [INFO] Configuration finale...

taskkill /f /im Spotify.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [INFO] Application de la configuration finale...
"%SPICETIFY_PATH%" apply

if !errorlevel! equ 0 (
    echo [OK] Configuration appliquee avec succes !
) else (
    echo [WARNING] Probleme d'application, mais Spicetify devrait fonctionner.
)

echo.
echo              INSTALLATION TERMINEE
echo.

if exist "%SPICETIFY_PATH%" (
    echo Spicetify: INSTALLE
) else (
    echo Spicetify: ECHEC
)

if exist "%MARKETPLACE_DIR%" (
    echo Marketplace: INSTALLE
) else (
    echo Marketplace: ECHEC
)

echo.
echo [INFO] Vous pouvez maintenant lancer Spotify !
echo [INFO] Le Marketplace sera accessible dans l'onglet "Marketplace"
echo [INFO] Si le theme ne s'affiche pas, relancez Spotify.
echo.

echo Appuyez sur une touche pour terminer...
pause >nul
exit /b 0