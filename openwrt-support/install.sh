#!/bin/sh
# rtp2httpd 一键安装脚本 for OpenWRT
# 自动从 GitHub Release 下载并安装最新版本

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# GitHub 仓库信息
REPO_OWNER="stackia"
REPO_NAME="rtp2httpd"
GITHUB_API="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}"
GITHUB_RELEASE="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download"

# 临时下载目录
TMP_DIR="/tmp/rtp2httpd_install"

# 打印信息函数
print_info() {
    printf "${GREEN}[INFO]${NC} %s\n" "$1"
}

print_warn() {
    printf "${YELLOW}[WARN]${NC} %s\n" "$1"
}

print_error() {
    printf "${RED}[ERROR]${NC} %s\n" "$1"
}

# 检查命令是否存在
check_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        print_error "未找到命令: $1"
        return 1
    fi
    return 0
}

# 检查必要的命令
check_requirements() {
    print_info "检查系统环境..."

    local missing_cmds=""

    for cmd in opkg curl; do
        if ! check_command "$cmd"; then
            missing_cmds="${missing_cmds} $cmd"
        fi
    done

    if [ -n "$missing_cmds" ]; then
        print_error "缺少必要的命令:${missing_cmds}"
        print_error "请先安装这些工具"
        exit 1
    fi

    print_info "系统环境检查通过"
}

# 获取 CPU 架构
get_cpu_arch() {
    print_info "检测 CPU 架构..."

    local arch=$(opkg print-architecture | awk '{print $2}' | grep -v "all" | grep -v "noarch" | head -n 1)

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

    local version=$(curl -sSL "${GITHUB_API}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')

    if [ -z "$version" ]; then
        print_error "无法获取最新版本信息"
        print_error "请检查网络连接或手动访问: https://github.com/${REPO_OWNER}/${REPO_NAME}/releases"
        exit 1
    fi

    print_info "最新版本: $version"
    echo "$version"
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

# 安装 IPK 包
install_package() {
    local package_file="$1"

    print_info "安装: $(basename "$package_file")"

    if ! opkg install "$package_file"; then
        print_warn "安装失败，尝试强制重新安装..."
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

# 主安装流程
main() {
    print_info "=========================================="
    print_info "rtp2httpd 一键安装脚本"
    print_info "=========================================="
    echo ""

    # 检查系统环境
    check_requirements

    # 获取 CPU 架构
    ARCH=$(get_cpu_arch)

    # 获取最新版本
    VERSION=$(get_latest_version)
    VERSION_NUM="${VERSION#v}"  # 去掉 v 前缀

    # 创建临时目录
    mkdir -p "$TMP_DIR"

    # 定义要下载的包
    MAIN_PACKAGE="rtp2httpd_${VERSION_NUM}-1_${ARCH}.ipk"
    LUCI_PACKAGE="luci-app-rtp2httpd_${VERSION_NUM}_all.ipk"
    I18N_EN_PACKAGE="luci-i18n-rtp2httpd-en_${VERSION_NUM}_all.ipk"
    I18N_ZH_CN_PACKAGE="luci-i18n-rtp2httpd-zh-cn_${VERSION_NUM}_all.ipk"

    # 下载所有包
    print_info ""
    print_info "开始下载软件包..."
    print_info "=========================================="

    PACKAGES="$MAIN_PACKAGE $LUCI_PACKAGE $I18N_EN_PACKAGE $I18N_ZH_CN_PACKAGE"
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

# 执行主函数
main

