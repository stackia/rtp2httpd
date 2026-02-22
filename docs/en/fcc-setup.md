# FCC Fast Channel Change Setup

Language: [中文](../fcc-setup.md) | [English](fcc-setup.md)

FCC (Fast Channel Change) is a carrier-grade protocol that enables millisecond-level channel switching. Most IPTV set-top boxes in China rely on FCC for fast channel changes.

## How FCC Works

On channel switch, the client first requests an FCC server to get a unicast video stream. The FCC server immediately sends IDR frames and initial data for instant decode. Once the unicast stream synchronizes with the multicast stream, it switches over seamlessly to multicast.

You must find the FCC server for the corresponding multicast source before using FCC.

## How to Find FCC Servers

### Method 1: Use a Known FCC List

Check the [Mainland China FCC server list](./cn-fcc-collection.md) to see if there is a local address available.

### Method 2: Capture from a Set-Top Box

If your region is not listed, you can capture traffic from an IPTV set-top box.

#### Capture with Wireshark

1. **Install Wireshark** on your PC.

2. **Connect the set-top box**:

   - Option 1: Use a network tap or mirrored port
   - Option 2: Set your PC as the set-top box gateway (MITM capture)

   There are many network tutorials for these methods.

3. **Find the channel list request and search for fields**:

   - Look for `ChannelFCCIP`: FCC server IP address
   - Look for `ChannelFCCPort`: FCC server port

4. **Or identify FCC protocol packets directly**:

   - Trigger FCC by switching channels and capture FCC packets directly
   - Install the [Wireshark FCC protocol plugin](../../wireshark-support/README.md)
   - Filter by `fcc`, then record the peer IP and port

## Configure and Use FCC

### Specify FCC Server in the URL

```url
http://server:port/rtp/multicast:port?fcc=FCC-IP:port[&fcc-type=protocol]
```

**Examples**:

```url
# Telecom FCC (auto-detect)
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:15970

# Huawei FCC (auto-detect)
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:8027

# Force Huawei FCC protocol
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:8027&fcc-type=huawei

# Force Telecom FCC protocol
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:15970&fcc-type=telecom
```

#### fcc-type Parameter

- **telecom** or omitted: Telecom/ZTE/FiberHome FCC protocol
- **huawei**: Huawei FCC protocol

In most cases, `telecom` works. Some specific networks require `huawei`.

### Configure FCC in M3U

If you use an M3U playlist, add the FCC parameters to each channel URL:

```m3u
#EXTM3U
#EXTINF:-1,CCTV-1 (Telecom FCC)
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:15970
#EXTINF:-1,CCTV-2 (Huawei FCC)
http://192.168.1.1:5140/rtp/239.253.64.121:5140?fcc=10.255.14.152:8027
```

## NAT Traversal

### Huawei FCC Protocol

The Huawei FCC protocol supports NAT traversal natively, so it works behind NAT without port forwarding. Huawei FCC only works on Huawei IPTV platforms.

### Telecom FCC Protocol

If you use the Telecom/ZTE/FiberHome FCC protocol and rtp2httpd runs behind a router (e.g., NAS, PC) while the upstream router connects to the IPTV network, port forwarding is required for FCC to work.

Most IPTV platforms (including Huawei) also support the Telecom FCC protocol.

You must also configure IGMP / multicast forwarding (`igmpproxy` / `omcproxy`) to receive multicast streams.

#### Configuration Steps

First, set `--fcc-listen-port-range` manually:

```bash
# Command line
rtp2httpd --fcc-listen-port-range 40000-40100

# Config file
[global]
fcc-listen-port-range = 40000-40100
```

Then configure port forwarding on the upstream router to forward this port range (e.g., `40000-40100`) to the device running rtp2httpd.

> **Tip**: If your environment needs NAT traversal and the FCC server supports both protocols, prefer the Huawei FCC protocol (port 8027) to avoid port forwarding.

## Test Whether FCC Works

1. **Use a fast-start player**: The player must be fast enough to avoid becoming the bottleneck.

2. **Observe channel switch speed**:

   - FCC enabled: switch delay < 1s
   - FCC disabled: 2-5 seconds

3. **Check logs**:

   - `FCC: Unicast stream started successfully` means the FCC address is valid and unicast streaming succeeded.
   - `FCC: Server response timeout (80 ms), falling back to multicast` can mean:
     1. The FCC address is invalid.
     2. Your network is not configured correctly and cannot reach the FCC server. In general, you must obtain an IPTV intranet IP via DHCP/IPoE/PPPoE and enable `--upstream-interface-fcc` or `--upstream-interface` to bind the IPTV interface. Use ping/traceroute to verify.

## Related Docs

- [URL Formats](url-formats.md): FCC URL format
- [Configuration Reference](configuration.md): FCC-related options
