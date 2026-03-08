#!/bin/sh
# rtp2httpd quick install script for OpenWRT
# Automatically download and install the latest version from GitHub Release

set -e

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# GitHub repository info
REPO_OWNER="stackia"
REPO_NAME="rtp2httpd"

# GitHub access configuration (set after user selection)
GITHUB_API=""
GITHUB_RELEASE=""
GITHUB_RAW=""

# Temporary download directory
TMP_DIR="/tmp/rtp2httpd_install"

# Whether to use prerelease version
USE_PRERELEASE=false

# Language: zh (default) or en
LANG_CODE="zh"

# Bilingual message function
msg() {
    if [ "$LANG_CODE" = "en" ]; then
        echo "$2"
    else
        echo "$1"
    fi
}

# Print functions
print_info() {
    printf "${GREEN}[INFO]${NC} %s\n" "$1" >&2
}

print_warn() {
    printf "${YELLOW}[WARN]${NC} %s\n" "$1" >&2
}

print_error() {
    printf "${RED}[ERROR]${NC} %s\n" "$1" >&2
}

# Select GitHub access method
select_github_mirror() {
    print_info "=========================================="
    print_info "$(msg '选择 GitHub 访问方式' 'Select GitHub Access Method')"
    print_info "=========================================="
    echo ""
    printf "${CYAN}$(msg '请选择访问方式:' 'Please select access method:')${NC}\n" >&2
    echo ""
    echo "  1) $(msg 'GitHub 官方 (直连)' 'GitHub Official (Direct)')"
    echo "  2) gh-proxy.com ($(msg '镜像加速' 'Mirror'))"
    echo "  3) ghfast.top ($(msg '镜像加速' 'Mirror'))"
    echo ""
    printf "$(msg '请输入选项 [1-3] (默认: 1): ' 'Enter option [1-3] (default: 1): ')" >&2

    # Read user input (from /dev/tty to support piped environments)
    read choice < /dev/tty

    # Use default if empty
    if [ -z "$choice" ]; then
        choice="1"
    fi

    echo ""

    # API always uses direct access to avoid rate limit
    GITHUB_API="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}"

    case "$choice" in
        1)
            print_info "$(msg '使用 GitHub 官方直连' 'Using GitHub Official (Direct)')"
            GITHUB_RELEASE="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download"
            GITHUB_RAW="https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}"
            ;;
        2)
            print_info "$(msg '使用 gh-proxy.com 镜像加速' 'Using gh-proxy.com mirror')"
            GITHUB_RELEASE="https://gh-proxy.com/https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download"
            GITHUB_RAW="https://gh-proxy.com/https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}"
            ;;
        3)
            print_info "$(msg '使用 ghfast.top 镜像加速' 'Using ghfast.top mirror')"
            GITHUB_RELEASE="https://ghfast.top/https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download"
            GITHUB_RAW="https://ghfast.top/https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}"
            ;;
        *)
            print_warn "$(msg '无效选项，使用默认方式: GitHub 官方直连' 'Invalid option, using default: GitHub Official (Direct)')"
            GITHUB_RELEASE="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download"
            GITHUB_RAW="https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}"
            ;;
    esac

    echo ""
}

# Check if a command exists
check_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        print_error "$(msg "未找到命令: $1" "Command not found: $1")"
        return 1
    fi
    return 0
}

# Detect package manager type
detect_package_manager() {
    if command -v apk >/dev/null 2>&1; then
        echo "apk"
    elif command -v opkg >/dev/null 2>&1; then
        echo "opkg"
    else
        echo ""
    fi
}

# Check required commands
check_requirements() {
    print_info "$(msg '检查系统环境...' 'Checking system environment...')"

    # Detect package manager
    PKG_MANAGER=$(detect_package_manager)

    if [ -z "$PKG_MANAGER" ]; then
        print_error "$(msg '未找到包管理器 (apk 或 opkg)' 'Package manager not found (apk or opkg)')"
        print_error "$(msg '请确认您的系统是 OpenWrt' 'Please confirm your system is OpenWrt')"
        exit 1
    fi

    print_info "$(msg "检测到包管理器: $PKG_MANAGER" "Detected package manager: $PKG_MANAGER")"

    # Check uclient-fetch
    if ! check_command uclient-fetch; then
        print_error "$(msg '未找到命令: uclient-fetch' 'Command not found: uclient-fetch')"
        print_error "$(msg '请先安装 uclient-fetch' 'Please install uclient-fetch first')"
        exit 1
    fi

    # Check jsonfilter
    if ! check_command jsonfilter; then
        print_error "$(msg '未找到命令: jsonfilter' 'Command not found: jsonfilter')"
        print_error "$(msg '请先安装 jshn 包' 'Please install jshn package first')"
        exit 1
    fi

    print_info "$(msg '系统环境检查通过' 'System environment check passed')"
}

# Check if already installed
check_installed() {
    print_info "$(msg '检查安装状态...' 'Checking installation status...')"

    local installed_version=""

    if [ "$PKG_MANAGER" = "apk" ]; then
        if apk info -e rtp2httpd >/dev/null 2>&1; then
            installed_version=$(apk info rtp2httpd | grep "^rtp2httpd-" | sed 's/rtp2httpd-//' | awk '{print $1}')
        fi
    else
        if opkg list-installed | grep -q "^rtp2httpd "; then
            installed_version=$(opkg list-installed rtp2httpd | awk '{print $3}')
        fi
    fi

    if [ -n "$installed_version" ]; then
        print_warn "$(msg "检测到已安装 rtp2httpd 版本: $installed_version" "Detected installed rtp2httpd version: $installed_version")"
        print_warn "$(msg '本脚本将进行更新操作' 'This script will perform an update')"
        echo ""
        printf "${YELLOW}$(msg '是否继续? [Y/n]: ' 'Continue? [Y/n]: ')${NC}" >&2
        read confirm < /dev/tty

        # Exit if user inputs n or N
        if [ "$confirm" = "n" ] || [ "$confirm" = "N" ]; then
            print_info "$(msg '已取消操作' 'Operation cancelled')"
            exit 0
        fi

        echo ""
        return 0
    else
        print_info "$(msg '未检测到已安装的 rtp2httpd' 'No existing rtp2httpd installation detected')"
        return 0
    fi
}

# Get CPU architecture
get_cpu_arch() {
    print_info "$(msg '检测 CPU 架构...' 'Detecting CPU architecture...')"

    local arch=""

    # Prefer reading full architecture info from /etc/openwrt_release
    if [ -f /etc/openwrt_release ]; then
        . /etc/openwrt_release
        if [ -n "$DISTRIB_ARCH" ]; then
            arch="$DISTRIB_ARCH"
            print_info "$(msg "从 OpenWrt 发行版信息获取架构: $arch" "Architecture from OpenWrt release info: $arch")"
        fi
    fi

    # Fallback to package manager detection
    if [ -z "$arch" ]; then
        if [ "$PKG_MANAGER" = "apk" ]; then
            arch=$(apk --print-arch 2>/dev/null)
        else
            arch=$(opkg print-architecture | awk '{print $2}' | grep -v "all" | grep -v "noarch" | head -n 1)
        fi
    fi

    if [ -z "$arch" ]; then
        print_error "$(msg '无法检测 CPU 架构' 'Unable to detect CPU architecture')"
        exit 1
    fi

    print_info "$(msg "检测到架构: $arch" "Detected architecture: $arch")"
    echo "$arch"
}

# Get latest version
get_latest_version() {
    print_info "$(msg '获取最新版本信息...' 'Fetching latest version info...')"

    local version=""

    # Check if using prerelease version
    if [ "$USE_PRERELEASE" = true ]; then
        print_info "$(msg '使用 prerelease 模式，将获取最新的预发布版本' 'Using prerelease mode, fetching latest pre-release version')"
        # Get all releases (including prerelease), take the first one
        version=$(uclient-fetch -q -O - "${GITHUB_API}/releases" | jsonfilter -e '@[0].tag_name')
    else
        # Only get latest stable version
        version=$(uclient-fetch -q -O - "${GITHUB_API}/releases/latest" | jsonfilter -e '@.tag_name')
    fi

    if [ -z "$version" ]; then
        print_error "$(msg '无法获取最新版本信息' 'Unable to fetch latest version info')"
        print_error "$(msg "请检查网络连接或手动访问: https://github.com/${REPO_OWNER}/${REPO_NAME}/releases" "Please check network connection or visit: https://github.com/${REPO_OWNER}/${REPO_NAME}/releases")"
        exit 1
    fi

    print_info "$(msg "最新版本: $version" "Latest version: $version")"
    echo "$version"
}

# Select version
select_version() {
    local latest_version="$1"

    # Strip v prefix for display
    local display_version="${latest_version#v}"

    printf "${CYAN}$(msg "请输入要安装的版本号 [默认: ${display_version}]: " "Enter version to install [default: ${display_version}]: ")${NC}" >&2

    # Read user input (from /dev/tty to support piped environments)
    read user_version < /dev/tty

    # Use default if empty (latest version)
    if [ -z "$user_version" ]; then
        user_version="$latest_version"
        print_info "$(msg "使用默认版本: ${display_version}" "Using default version: ${display_version}")"
    else
        # Strip possible v prefix from user input
        user_version="${user_version#v}"

        print_info "$(msg "用户选择版本: ${user_version}" "Selected version: ${user_version}")"

        # Add v prefix for API query
        local version_tag="v${user_version}"

        # Verify version exists
        print_info "$(msg '验证版本是否存在...' 'Verifying version exists...')"
        local version_check=$(uclient-fetch -q -O - "${GITHUB_API}/releases/tags/${version_tag}" 2>/dev/null | jsonfilter -e '@.tag_name' 2>/dev/null)

        if [ -z "$version_check" ]; then
            print_error "$(msg "版本 ${user_version} 不存在" "Version ${user_version} does not exist")"
            print_error "$(msg "请访问 https://github.com/${REPO_OWNER}/${REPO_NAME}/releases 查看可用版本" "Please visit https://github.com/${REPO_OWNER}/${REPO_NAME}/releases for available versions")"
            exit 1
        fi

        print_info "$(msg '版本验证通过' 'Version verified')"

        # Return version with v prefix
        user_version="$version_tag"
    fi

    echo "$user_version"
}

# Get release assets for a specific version
get_release_assets() {
    local version="$1"

    print_info "$(msg '获取 Release Assets 列表...' 'Fetching release assets list...')"

    local assets=$(uclient-fetch -q -O - "${GITHUB_API}/releases/tags/${version}" | jsonfilter -e '@.assets[*].name')

    if [ -z "$assets" ]; then
        print_error "$(msg '无法获取 Release Assets 列表' 'Unable to fetch release assets list')"
        exit 1
    fi

    echo "$assets"
}

# Match package filename from assets list
# Args: $1=assets list $2=package prefix $3=architecture $4=package extension
match_package_name() {
    local assets="$1"
    local prefix="$2"
    local arch="$3"
    local ext="$4"

    local matched=""

    if [ "$arch" != "all" ]; then
        # Main package needs to match architecture
        matched=$(echo "$assets" | grep "^${prefix}[_-].*_${arch}\.${ext}$" | head -n 1)
    else
        # luci-related packages are usually all architecture
        matched=$(echo "$assets" | grep "^${prefix}[_-].*\.${ext}$" | head -n 1)
    fi

    if [ -z "$matched" ]; then
        print_warn "$(msg "未找到匹配的包: ${prefix} (架构: ${arch})" "No matching package found: ${prefix} (arch: ${arch})")"
        return 1
    fi

    echo "$matched"
    return 0
}

# Build download URL
build_download_url() {
    local version="$1"
    local arch="$2"
    local package_name="$3"

    echo "${GITHUB_RELEASE}/${version}/${package_name}"
}

# Download file
download_file() {
    local url="$1"
    local output="$2"

    print_info "$(msg '下载' 'Downloading'): $(basename "$output")"

    if ! uclient-fetch -q -O "$output" "$url"; then
        print_error "$(msg "下载失败: $url" "Download failed: $url")"
        return 1
    fi

    return 0
}

# Install package
install_package() {
    local package_file="$1"

    print_info "$(msg '安装' 'Installing'): $(basename "$package_file")"

    if [ "$PKG_MANAGER" = "apk" ]; then
        if ! apk add --allow-untrusted "$package_file"; then
            print_error "$(msg "安装失败: $(basename "$package_file")" "Installation failed: $(basename "$package_file")")"
            return 1
        fi
    else
        if ! opkg install --force-reinstall --force-downgrade "$package_file"; then
            print_error "$(msg "安装失败: $(basename "$package_file")" "Installation failed: $(basename "$package_file")")"
            return 1
        fi
    fi

    return 0
}

# Clean up temporary files
cleanup() {
    if [ -d "$TMP_DIR" ]; then
        print_info "$(msg '清理临时文件...' 'Cleaning up temporary files...')"
        rm -rf "$TMP_DIR"
    fi
}

# Parse command line arguments
parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --lang)
                if [ -n "$2" ]; then
                    LANG_CODE="$2"
                    shift
                else
                    print_error "$(msg '--lang 需要指定语言代码 (zh 或 en)' '--lang requires a language code (zh or en)')"
                    exit 1
                fi
                shift
                ;;
            --prerelease)
                USE_PRERELEASE=true
                shift
                ;;
            --help|-h)
                echo "$(msg '用法' 'Usage'): $0 [$(msg '选项' 'options')]"
                echo ""
                echo "$(msg '选项' 'Options'):"
                echo "  --lang <zh|en>  $(msg '设置界面语言（默认: zh）' 'Set display language (default: zh)')"
                echo "  --prerelease    $(msg '安装最新的预发布版本（包括 prerelease）' 'Install the latest pre-release version')"
                echo "  --help, -h      $(msg '显示此帮助信息' 'Show this help message')"
                echo ""
                exit 0
                ;;
            *)
                print_error "$(msg "未知参数: $1" "Unknown argument: $1")"
                echo "$(msg '使用 --help 查看帮助信息' 'Use --help for help')"
                exit 1
                ;;
        esac
    done
}

# Main install flow
main() {
    print_info "=========================================="
    print_info "$(msg 'rtp2httpd 一键安装脚本' 'rtp2httpd Quick Installer')"
    print_info "=========================================="
    echo ""

    # Select GitHub access method
    select_github_mirror

    # Check system environment
    check_requirements

    # Check if already installed
    check_installed

    # Get CPU architecture
    ARCH=$(get_cpu_arch)

    # Get latest version
    LATEST_VERSION=$(get_latest_version)

    # Let user select version to install
    VERSION=$(select_version "$LATEST_VERSION")

    # Get all assets for this version
    ASSETS=$(get_release_assets "$VERSION")

    # Create temporary directory
    mkdir -p "$TMP_DIR"

    # Determine package extension based on package manager
    if [ "$PKG_MANAGER" = "apk" ]; then
        PKG_EXT="apk"
    else
        PKG_EXT="ipk"
    fi

    # Match package filenames from assets list
    print_info ""
    print_info "$(msg '匹配软件包文件名...' 'Matching package filenames...')"
    print_info "=========================================="

    MAIN_PACKAGE=$(match_package_name "$ASSETS" "rtp2httpd" "$ARCH" "$PKG_EXT")
    LUCI_PACKAGE=$(match_package_name "$ASSETS" "luci-app-rtp2httpd" "all" "$PKG_EXT")
    I18N_ZH_CN_PACKAGE=$(match_package_name "$ASSETS" "luci-i18n-rtp2httpd-zh-cn" "all" "$PKG_EXT")

    # Check required packages are found
    if [ -z "$MAIN_PACKAGE" ]; then
        print_error "$(msg "未找到主程序包: rtp2httpd (架构: ${ARCH})" "Main package not found: rtp2httpd (arch: ${ARCH})")"
        print_error "$(msg '请检查该版本是否支持您的架构' 'Please check if this version supports your architecture')"
        cleanup
        exit 1
    fi

    if [ -z "$LUCI_PACKAGE" ]; then
        print_error "$(msg '未找到 LuCI 应用包: luci-app-rtp2httpd' 'LuCI app package not found: luci-app-rtp2httpd')"
        cleanup
        exit 1
    fi

    print_info "$(msg "找到主程序包: $MAIN_PACKAGE" "Found main package: $MAIN_PACKAGE")"
    print_info "$(msg "找到 LuCI 应用包: $LUCI_PACKAGE" "Found LuCI app package: $LUCI_PACKAGE")"

    if [ -n "$I18N_ZH_CN_PACKAGE" ]; then
        print_info "$(msg "找到中文语言包: $I18N_ZH_CN_PACKAGE" "Found Chinese language pack: $I18N_ZH_CN_PACKAGE")"
    else
        print_warn "$(msg '未找到中文语言包，将跳过' 'Chinese language pack not found, skipping')"
    fi

    # Download all packages
    print_info ""
    print_info "$(msg '开始下载软件包...' 'Downloading packages...')"
    print_info "=========================================="

    # Build package list (only include found packages)
    PACKAGES="$MAIN_PACKAGE $LUCI_PACKAGE"
    if [ -n "$I18N_ZH_CN_PACKAGE" ]; then
        PACKAGES="$PACKAGES $I18N_ZH_CN_PACKAGE"
    fi

    DOWNLOAD_SUCCESS=true

    for package in $PACKAGES; do
        url=$(build_download_url "$VERSION" "$ARCH" "$package")
        output="${TMP_DIR}/${package}"

        if ! download_file "$url" "$output"; then
            DOWNLOAD_SUCCESS=false
            break
        fi
    done

    if [ "$DOWNLOAD_SUCCESS" = false ]; then
        print_error "$(msg '下载失败，安装中止' 'Download failed, installation aborted')"
        cleanup
        exit 1
    fi

    # Install all packages
    print_info ""
    print_info "$(msg '开始安装软件包...' 'Installing packages...')"
    print_info "=========================================="

    INSTALL_SUCCESS=true

    for package in $PACKAGES; do
        package_file="${TMP_DIR}/${package}"

        if ! install_package "$package_file"; then
            INSTALL_SUCCESS=false
            break
        fi
    done

    # Clean up temporary files
    cleanup

    if [ "$INSTALL_SUCCESS" = false ]; then
        print_error ""
        print_error "$(msg '安装失败！' 'Installation failed!')"
        exit 1
    fi

    # Installation successful
    print_info ""
    print_info "=========================================="
    print_info "$(msg '安装完成！' 'Installation complete!')"
    print_info "=========================================="
    print_info ""
    print_info "$(msg "已安装版本: $VERSION" "Installed version: $VERSION")"
    print_info ""
    print_info "$(msg '后续步骤：' 'Next steps:')"
    print_info "$(msg '1. 访问 LuCI 管理界面' '1. Access the LuCI admin interface')"
    print_info "$(msg "2. 在 '服务' 菜单中找到 'rtp2httpd'" "2. Find 'rtp2httpd' in the 'Services' menu")"
    print_info "$(msg '3. 根据需要配置服务参数' '3. Configure the service parameters as needed')"
    print_info "$(msg '4. 启动服务' '4. Start the service')"
    print_info ""
    print_info "$(msg '更多信息请访问' 'For more info visit'): https://github.com/${REPO_OWNER}/${REPO_NAME}"
    print_info ""
}

# Trap exit signals to ensure cleanup
trap cleanup EXIT INT TERM

# Parse command line arguments
parse_args "$@"

# Execute main function
main
