#!/bin/sh
# rtp2httpd 一键安装脚本 for OpenWRT
# 自动从 GitHub Release 下载并安装最新版本

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# GitHub 仓库信息
REPO_OWNER="stackia"
REPO_NAME="rtp2httpd"

# GitHub 访问方式配置(将在用户选择后设置)
GITHUB_API=""
GITHUB_RELEASE=""
GITHUB_RAW=""

# 临时下载目录
TMP_DIR="/tmp/rtp2httpd_install"

# 是否使用 prerelease 版本
USE_PRERELEASE=false

# 打印信息函数
print_info() {
    printf "${GREEN}[INFO]${NC} %s\n" "$1" >&2
}

print_warn() {
    printf "${YELLOW}[WARN]${NC} %s\n" "$1" >&2
}

print_error() {
    printf "${RED}[ERROR]${NC} %s\n" "$1" >&2
}

# 选择 GitHub 访问方式
select_github_mirror() {
    print_info "=========================================="
    print_info "选择 GitHub 访问方式"
    print_info "=========================================="
    echo ""
    printf "${CYAN}请选择访问方式:${NC}\n" >&2
    echo ""
    echo "  1) gh-proxy.com (镜像加速)"
    echo "  2) GitHub 官方 (直连)"
    echo ""
    printf "请输入选项 [1-2] (默认: 1): " >&2

    # 读取用户输入（从 /dev/tty 读取以支持管道环境）
    read choice < /dev/tty

    # 如果输入为空，使用默认值
    if [ -z "$choice" ]; then
        choice="1"
    fi

    echo ""

    case "$choice" in
        1)
            print_info "使用 gh-proxy.com 镜像加速"
            GITHUB_API="https://gh-proxy.com/https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}"
            GITHUB_RELEASE="https://gh-proxy.com/https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download"
            GITHUB_RAW="https://gh-proxy.com/https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}"
            ;;
        2)
            print_info "使用 GitHub 官方直连"
            GITHUB_API="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}"
            GITHUB_RELEASE="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download"
            GITHUB_RAW="https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}"
            ;;
        *)
            print_warn "无效选项，使用默认方式: gh-proxy.com 镜像加速"
            GITHUB_API="https://gh-proxy.com/https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}"
            GITHUB_RELEASE="https://gh-proxy.com/https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download"
            GITHUB_RAW="https://gh-proxy.com/https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}"
            ;;
    esac

    echo ""
}

# 检查命令是否存在
check_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        print_error "未找到命令: $1"
        return 1
    fi
    return 0
}

# 检测包管理器类型
detect_package_manager() {
    if command -v apk >/dev/null 2>&1; then
        echo "apk"
    elif command -v opkg >/dev/null 2>&1; then
        echo "opkg"
    else
        echo ""
    fi
}

# 检查必要的命令
check_requirements() {
    print_info "检查系统环境..."

    # 检测包管理器
    PKG_MANAGER=$(detect_package_manager)

    if [ -z "$PKG_MANAGER" ]; then
        print_error "未找到包管理器 (apk 或 opkg)"
        print_error "请确认您的系统是 OpenWrt"
        exit 1
    fi

    print_info "检测到包管理器: $PKG_MANAGER"

    # 检查 curl
    if ! check_command curl; then
        print_error "未找到命令: curl"
        print_error "请先安装 curl"
        exit 1
    fi

    print_info "系统环境检查通过"
}

# 检查是否已安装
check_installed() {
    print_info "检查安装状态..."

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
        print_warn "检测到已安装 rtp2httpd 版本: $installed_version"
        print_warn "本脚本将进行更新操作"
        echo ""
        printf "${YELLOW}是否继续? [Y/n]: ${NC}" >&2
        read confirm < /dev/tty

        # 如果用户输入 n 或 N，则退出
        if [ "$confirm" = "n" ] || [ "$confirm" = "N" ]; then
            print_info "已取消操作"
            exit 0
        fi

        echo ""
        return 0
    else
        print_info "未检测到已安装的 rtp2httpd"
        return 0
    fi
}

# 获取 CPU 架构
get_cpu_arch() {
    print_info "检测 CPU 架构..."

    local arch=""

    # 优先从 /etc/openwrt_release 读取完整架构信息
    if [ -f /etc/openwrt_release ]; then
        . /etc/openwrt_release
        if [ -n "$DISTRIB_ARCH" ]; then
            arch="$DISTRIB_ARCH"
            print_info "从 OpenWrt 发行版信息获取架构: $arch"
        fi
    fi

    # 如果未获取到,使用包管理器检测
    if [ -z "$arch" ]; then
        if [ "$PKG_MANAGER" = "apk" ]; then
            arch=$(apk --print-arch 2>/dev/null)
        else
            arch=$(opkg print-architecture | awk '{print $2}' | grep -v "all" | grep -v "noarch" | head -n 1)
        fi
    fi

    if [ -z "$arch" ]; then
        print_error "无法检测 CPU 架构"
        exit 1
    fi

    print_info "检测到架构: $arch"
    echo "$arch"
}

# 获取最新版本号
get_latest_version() {
    print_info "获取最新版本信息..."

    local version=""

    # 检查是否使用 prerelease 版本
    if [ "$USE_PRERELEASE" = true ]; then
        print_info "使用 prerelease 模式，将获取最新的预发布版本"
        # 获取所有 releases（包括 prerelease），取第一个
        version=$(curl -sSL "${GITHUB_API}/releases" | grep '"tag_name":' | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/')
    else
        # 只获取最新的正式版本
        version=$(curl -sSL "${GITHUB_API}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
    fi

    if [ -z "$version" ]; then
        print_error "无法获取最新版本信息"
        print_error "请检查网络连接或手动访问: https://github.com/${REPO_OWNER}/${REPO_NAME}/releases"
        exit 1
    fi

    print_info "最新版本: $version"
    echo "$version"
}

# 选择版本号
select_version() {
    local latest_version="$1"

    # 去掉 v 前缀用于显示
    local display_version="${latest_version#v}"

    printf "${CYAN}请输入要安装的版本号 [默认: ${display_version}]: ${NC}" >&2

    # 读取用户输入（从 /dev/tty 读取以支持管道环境）
    read user_version < /dev/tty

    # 如果输入为空，使用默认值（最新版本）
    if [ -z "$user_version" ]; then
        user_version="$latest_version"
        print_info "使用默认版本: ${display_version}"
    else
        # 去掉用户输入中可能带的 v 前缀
        user_version="${user_version#v}"

        print_info "用户选择版本: ${user_version}"

        # 添加 v 前缀用于 API 查询
        local version_tag="v${user_version}"

        # 验证版本是否存在
        print_info "验证版本是否存在..."
        local version_check=$(curl -sSL "${GITHUB_API}/releases/tags/${version_tag}" 2>/dev/null | grep '"tag_name":')

        if [ -z "$version_check" ]; then
            print_error "版本 ${user_version} 不存在"
            print_error "请访问 https://github.com/${REPO_OWNER}/${REPO_NAME}/releases 查看可用版本"
            exit 1
        fi

        print_info "版本验证通过"

        # 返回带 v 前缀的版本号
        user_version="$version_tag"
    fi

    echo "$user_version"
}

# 获取指定版本的所有 release assets
get_release_assets() {
    local version="$1"

    print_info "获取 Release Assets 列表..."

    local assets=$(curl -sSL "${GITHUB_API}/releases/tags/${version}" | grep '"name":' | sed -E 's/.*"name":\s*"([^"]+)".*/\1/')

    if [ -z "$assets" ]; then
        print_error "无法获取 Release Assets 列表"
        exit 1
    fi

    echo "$assets"
}

# 从 assets 列表中匹配包文件名
# 参数: $1=assets列表 $2=包名前缀 $3=架构 $4=包扩展名
match_package_name() {
    local assets="$1"
    local prefix="$2"
    local arch="$3"
    local ext="$4"

    # 根据前缀和架构匹配
    # 对于主包: rtp2httpd_*_${arch}.${ext}
    # 对于 luci 相关包: ${prefix}_*_all.${ext} 或 ${prefix}_*.${ext}

    local matched=""

    if [ "$arch" != "all" ]; then
        # 主包需要匹配架构
        matched=$(echo "$assets" | grep "^${prefix}[_-].*_${arch}\.${ext}$" | head -n 1)
    else
        # luci 相关包通常是 all 架构
        matched=$(echo "$assets" | grep "^${prefix}[_-].*\.${ext}$" | head -n 1)
    fi

    if [ -z "$matched" ]; then
        print_warn "未找到匹配的包: ${prefix} (架构: ${arch})"
        return 1
    fi

    echo "$matched"
    return 0
}

# 构建下载 URL
build_download_url() {
    local version="$1"
    local arch="$2"
    local package_name="$3"

    echo "${GITHUB_RELEASE}/${version}/${package_name}"
}

# 下载文件
download_file() {
    local url="$1"
    local output="$2"

    print_info "下载: $(basename "$output")"

    if ! curl -fsSL --insecure --progress-bar -o "$output" "$url"; then
        print_error "下载失败: $url"
        return 1
    fi

    return 0
}

# 安装软件包
install_package() {
    local package_file="$1"

    print_info "安装: $(basename "$package_file")"

    if [ "$PKG_MANAGER" = "apk" ]; then
        if ! apk add --allow-untrusted "$package_file"; then
            print_error "安装失败: $(basename "$package_file")"
            return 1
        fi
    else
        if ! opkg install --force-reinstall --force-downgrade "$package_file"; then
            print_error "安装失败: $(basename "$package_file")"
            return 1
        fi
    fi

    return 0
}

# 清理临时文件
cleanup() {
    if [ -d "$TMP_DIR" ]; then
        print_info "清理临时文件..."
        rm -rf "$TMP_DIR"
    fi
}

# 解析命令行参数
parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --prerelease)
                USE_PRERELEASE=true
                shift
                ;;
            --help|-h)
                echo "用法: $0 [选项]"
                echo ""
                echo "选项:"
                echo "  --prerelease    安装最新的预发布版本（包括 prerelease）"
                echo "  --help, -h      显示此帮助信息"
                echo ""
                exit 0
                ;;
            *)
                print_error "未知参数: $1"
                echo "使用 --help 查看帮助信息"
                exit 1
                ;;
        esac
    done
}

# 主安装流程
main() {
    print_info "=========================================="
    print_info "rtp2httpd 一键安装脚本"
    print_info "=========================================="
    echo ""

    # 选择 GitHub 访问方式
    select_github_mirror

    # 检查系统环境
    check_requirements

    # 检查是否已安装
    check_installed

    # 获取 CPU 架构
    ARCH=$(get_cpu_arch)

    # 获取最新版本
    LATEST_VERSION=$(get_latest_version)

    # 让用户选择要安装的版本
    VERSION=$(select_version "$LATEST_VERSION")

    # 获取该版本的所有 assets
    ASSETS=$(get_release_assets "$VERSION")

    # 创建临时目录
    mkdir -p "$TMP_DIR"

    # 根据包管理器确定包扩展名
    if [ "$PKG_MANAGER" = "apk" ]; then
        PKG_EXT="apk"
    else
        PKG_EXT="ipk"
    fi

    # 从 assets 列表中匹配包文件名
    print_info ""
    print_info "匹配软件包文件名..."
    print_info "=========================================="

    MAIN_PACKAGE=$(match_package_name "$ASSETS" "rtp2httpd" "$ARCH" "$PKG_EXT")
    LUCI_PACKAGE=$(match_package_name "$ASSETS" "luci-app-rtp2httpd" "all" "$PKG_EXT")
    I18N_ZH_CN_PACKAGE=$(match_package_name "$ASSETS" "luci-i18n-rtp2httpd-zh-cn" "all" "$PKG_EXT")

    # 检查必须的包是否都匹配到了
    if [ -z "$MAIN_PACKAGE" ]; then
        print_error "未找到主程序包: rtp2httpd (架构: ${ARCH})"
        print_error "请检查该版本是否支持您的架构"
        cleanup
        exit 1
    fi

    if [ -z "$LUCI_PACKAGE" ]; then
        print_error "未找到 LuCI 应用包: luci-app-rtp2httpd"
        cleanup
        exit 1
    fi

    print_info "找到主程序包: $MAIN_PACKAGE"
    print_info "找到 LuCI 应用包: $LUCI_PACKAGE"

    if [ -n "$I18N_ZH_CN_PACKAGE" ]; then
        print_info "找到中文语言包: $I18N_ZH_CN_PACKAGE"
    else
        print_warn "未找到中文语言包，将跳过"
    fi

    # 下载所有包
    print_info ""
    print_info "开始下载软件包..."
    print_info "=========================================="

    # 构建要下载的包列表（只包含找到的包）
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
        print_error "下载失败，安装中止"
        cleanup
        exit 1
    fi

    # 安装所有包
    print_info ""
    print_info "开始安装软件包..."
    print_info "=========================================="

    INSTALL_SUCCESS=true

    for package in $PACKAGES; do
        package_file="${TMP_DIR}/${package}"

        if ! install_package "$package_file"; then
            INSTALL_SUCCESS=false
            break
        fi
    done

    # 清理临时文件
    cleanup

    if [ "$INSTALL_SUCCESS" = false ]; then
        print_error ""
        print_error "安装失败！"
        exit 1
    fi

    # 安装成功
    print_info ""
    print_info "=========================================="
    print_info "安装完成！"
    print_info "=========================================="
    print_info ""
    print_info "已安装版本: $VERSION"
    print_info ""
    print_info "后续步骤："
    print_info "1. 访问 LuCI 管理界面"
    print_info "2. 在 '服务' 菜单中找到 'rtp2httpd'"
    print_info "3. 根据需要配置服务参数"
    print_info "4. 启动服务"
    print_info ""
    print_info "更多信息请访问: https://github.com/${REPO_OWNER}/${REPO_NAME}"
    print_info ""
}

# 捕获退出信号，确保清理临时文件
trap cleanup EXIT INT TERM

# 解析命令行参数
parse_args "$@"

# 执行主函数
main

