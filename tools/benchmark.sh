#!/bin/bash
#
# Benchmark script for rtp2httpd, msd_lite, udpxy, and tvgate
#
# Runs stress tests sequentially to ensure accurate measurements.
# Results are collected and summarized at the end.
#
# Usage:
#   ./benchmark.sh              # Run all programs
#   ./benchmark.sh rtp2httpd    # Run only rtp2httpd tests
#   ./benchmark.sh tvgate       # Run only tvgate tests
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# All available programs
ALL_PROGRAMS=("rtp2httpd" "msd_lite" "udpxy" "tvgate")

# Parse command line arguments
if [ $# -gt 0 ]; then
    # Validate provided program name
    valid=false
    for p in "${ALL_PROGRAMS[@]}"; do
        if [ "$1" = "$p" ]; then
            valid=true
            break
        fi
    done
    if [ "$valid" = false ]; then
        echo "Error: Unknown program '$1'"
        echo "Available programs: ${ALL_PROGRAMS[*]}"
        exit 1
    fi
    PROGRAMS=("$1")
else
    PROGRAMS=("${ALL_PROGRAMS[@]}")
fi

# Activate virtual environment
if [ -f ".venv/bin/activate" ]; then
    source .venv/bin/activate
else
    echo "Error: Virtual environment not found at $SCRIPT_DIR/.venv"
    echo "Please run: cd tools && uv sync"
    exit 1
fi

# Output file for results
RESULTS_FILE="benchmark_results_$(date +%Y%m%d_%H%M%S).txt"

# Test duration
DURATION=10

# Delay between tests (seconds)
DELAY=3

echo "============================================================"
echo "Benchmark Suite for Streaming Servers"
echo "============================================================"
echo "Date: $(date)"
echo "Duration per test: ${DURATION}s"
echo "Programs: ${PROGRAMS[*]}"
echo "Results will be saved to: $RESULTS_FILE"
echo "============================================================"
echo ""

# Initialize results file
cat > "$RESULTS_FILE" << EOF
============================================================
Benchmark Results - $(date)
============================================================

Test Environment:
- Duration per test: ${DURATION}s
- Programs tested: ${PROGRAMS[*]}

EOF

run_test() {
    local program="$1"
    local description="$2"
    shift 2
    local extra_args="$@"

    echo "------------------------------------------------------------"
    echo "Testing: $program - $description"
    echo "Args: $extra_args"
    echo "------------------------------------------------------------"

    # Add header to results file
    echo "" >> "$RESULTS_FILE"
    echo "------------------------------------------------------------" >> "$RESULTS_FILE"
    echo "Test: $program - $description" >> "$RESULTS_FILE"
    echo "Args: $extra_args" >> "$RESULTS_FILE"
    echo "------------------------------------------------------------" >> "$RESULTS_FILE"

    # Run the test and capture output
    if python stress_test.py --program "$program" --duration "$DURATION" $extra_args 2>&1 | tee -a "$RESULTS_FILE"; then
        echo "✓ Test completed"
    else
        echo "✗ Test failed"
        echo "TEST FAILED" >> "$RESULTS_FILE"
    fi

    echo ""
    echo "Waiting ${DELAY}s before next test..."
    sleep "$DELAY"
}

total_tests=$((${#PROGRAMS[@]} * 3))
current_test=0

for program in "${PROGRAMS[@]}"; do
    # Check if program binary exists
    case "$program" in
        rtp2httpd)
            binary="../src/rtp2httpd"
            ;;
        msd_lite)
            binary="../../msd_lite/build/src/msd_lite"
            ;;
        udpxy)
            binary="../../udpxy/chipmunk/udpxy"
            ;;
        tvgate)
            binary="../../tvgate/TVGate-linux-arm64"
            ;;
    esac

    if [ ! -f "$binary" ]; then
        echo "Warning: $program binary not found at $binary, skipping..."
        echo "SKIPPED: $program binary not found" >> "$RESULTS_FILE"
        continue
    fi

    echo ""
    echo "============================================================"
    echo "Testing: $program"
    echo "============================================================"
    echo ""

    # Test 1: 8 clients, unique addresses (default)
    current_test=$((current_test + 1))
    echo "[$current_test/$total_tests] $program: 8 clients, unique addresses, 5x speed (~40 Mbps)"
    run_test "$program" "8 clients, unique addresses, 40 Mbps" --clients 8 --speed 5

    # Test 2: 8 clients, same address
    current_test=$((current_test + 1))
    echo "[$current_test/$total_tests] $program: 8 clients, same address, 5x speed (~40 Mbps)"
    run_test "$program" "8 clients, same address, 40 Mbps" --clients 8 --speed 5 --same-address

    # Test 3: 1 client, high bitrate (400 Mbps)
    current_test=$((current_test + 1))
    echo "[$current_test/$total_tests] $program: 1 client, 50x speed (~400 Mbps)"
    run_test "$program" "1 client, 400 Mbps" --clients 1 --speed 50
done

echo ""
echo "============================================================"
echo "Benchmark Complete!"
echo "============================================================"
echo "Results saved to: $RESULTS_FILE"
echo ""

# Generate summary
echo "" >> "$RESULTS_FILE"
echo "============================================================" >> "$RESULTS_FILE"
echo "SUMMARY" >> "$RESULTS_FILE"
echo "============================================================" >> "$RESULTS_FILE"

# Extract and format summary from results
echo ""
echo "Extracting summary..."
echo ""

# Parse results and create summary table
{
    echo ""
    echo "Performance Summary Table:"
    echo ""
    printf "%-12s %-30s %10s %10s %10s %10s\n" "Program" "Test" "CPU Avg" "CPU Max" "PSS Avg" "USS Avg"
    printf "%-12s %-30s %10s %10s %10s %10s\n" "-------" "----" "-------" "-------" "-------" "-------"

    current_program=""
    current_test=""

    while IFS= read -r line; do
        if [[ "$line" =~ ^Test:\ ([a-z0-9_]+)\ -\ (.+)$ ]]; then
            current_program="${BASH_REMATCH[1]}"
            current_test="${BASH_REMATCH[2]}"
        elif [[ "$line" =~ CPU:\ +avg=\ *([0-9.]+)%\ +max=\ *([0-9.]+)% ]]; then
            cpu_avg="${BASH_REMATCH[1]}"
            cpu_max="${BASH_REMATCH[2]}"
        elif [[ "$line" =~ PSS:\ +avg=\ *([0-9.]+)MB ]]; then
            pss_avg="${BASH_REMATCH[1]}"
        elif [[ "$line" =~ USS:\ +avg=\ *([0-9.]+)MB ]]; then
            uss_avg="${BASH_REMATCH[1]}"
            # Only print when we have the program stats (first stats block after test header)
            if [[ -n "$current_program" && -n "$current_test" && -n "$cpu_avg" ]]; then
                printf "%-12s %-30s %9s%% %9s%% %9sMB %9sMB\n" "$current_program" "$current_test" "$cpu_avg" "$cpu_max" "$pss_avg" "$uss_avg"
                current_program=""
                current_test=""
                cpu_avg=""
            fi
        fi
    done < "$RESULTS_FILE"
} | tee -a "$RESULTS_FILE"

echo ""
echo "Full results saved to: $RESULTS_FILE"
