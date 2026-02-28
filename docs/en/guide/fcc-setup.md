# Fast Channel Change Configuration

FCC (Fast Channel Change) is a carrier-grade fast channel switching protocol that enables millisecond-level channel change response. Most IPTV set-top boxes in China achieve fast channel switching through FCC.

## How FCC Works

### Why Is Pure Multicast Slow to Start?

Video encoding (such as H.264/H.265) uses inter-frame compression. Only keyframes (IDR frames) contain complete picture information, while subsequent frames (P-frames, B-frames) depend on keyframes for decoding. Multicast streams are continuously transmitted. When a player joins midway, the first packet received is most likely not a keyframe. The player must wait for the next keyframe to arrive before it can start decoding. The keyframe interval (GOP) is typically 1-5 seconds, so there is a noticeable delay when switching channels with pure multicast.

### How Does FCC Achieve Fast Playback?

FCC servers cache the most recent keyframes of each channel. When a player switches channels:

1. rtp2httpd initiates a unicast request to the FCC server
2. The FCC server immediately returns the cached keyframe and subsequent data, allowing the player to start decoding without waiting
3. At the same time, rtp2httpd also joins the multicast group of the corresponding channel
4. When the unicast stream and multicast stream are synchronized, rtp2httpd seamlessly switches to the multicast stream and disconnects the unicast connection

The entire process is transparent to the player, ensuring that the first frame received by the player is an IDR frame that can be immediately decoded for display.

Therefore, you must first find the FCC server corresponding to your multicast source before you can use it.

## How to Obtain FCC Server

### Method 1: Check Known FCC Server List

You can first check the [China FCC Address Collection](/en/reference/cn-fcc-collection), and try to find an available address for your local area.

### Method 2: Capture Packets from Set-Top Box

If your region is not in the list, you need to capture packets from your IPTV set-top box.

#### Using Wireshark to Capture Packets

1. **Install Wireshark**: Install the Wireshark packet capture tool on your PC

2. **Connect the Set-Top Box**:

   - Method 1: Use a network tap or mirror port
   - Method 2: Set the PC as the gateway of the set-top box for man-in-the-middle packet capture

   Specific methods are not detailed here, as there are many online tutorials.

3. **Find the channel list request and search for key fields**:

   - Look for the `ChannelFCCIP` field: FCC server IP address
   - Look for the `ChannelFCCPort` field: FCC server port number

4. **Or directly identify FCC protocol packets**:

   - Alternatively, you can try to play directly and trigger the FCC process by switching channels to capture FCC protocol packets
   - Download and install the [Wireshark FCC Protocol Plugin](https://github.com/stackia/rtp2httpd/blob/main/wireshark-support/README.md)
   - Filter by `fcc` to locate FCC protocol packets and record the remote IP and port

## Configuring and Using FCC

### Specify FCC Server in URL

```url
http://server-address:port/rtp/multicast-address:port?fcc=FCC-server-IP:port[&fcc-type=protocol-type]
```

**Examples**:

```url
# Telecom FCC (auto-detect)
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:15970

# Huawei FCC (auto-detect)
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:8027

# Manually specify Huawei FCC protocol
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:8027&fcc-type=huawei

# Manually specify Telecom FCC protocol
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:15970&fcc-type=telecom
```

#### fcc-type Parameter Description

- **telecom** or not specified: Use Telecom/ZTE/FiberHome FCC protocol
- **huawei**: Use Huawei FCC protocol

In most cases, `telecom` will work. In some specific network environments, the `huawei` protocol may be required.

### Configure FCC in M3U

If you are using an M3U playlist, you can add FCC parameters to the URL of each channel:

```m3u
#EXTM3U
#EXTINF:-1,CCTV-1 (Telecom FCC)
http://192.168.1.1:5140/rtp/239.253.64.120:5140?fcc=10.255.14.152:15970
#EXTINF:-1,CCTV-2 (Huawei FCC)
http://192.168.1.1:5140/rtp/239.253.64.121:5140?fcc=10.255.14.152:8027
```

## NAT Traversal Configuration

> [!IMPORTANT]
> NAT traversal configuration is only required when rtp2httpd is running behind a NAT device (such as NAS or secondary router). If the device/container running rtp2httpd has direct IPTV network access (can directly obtain an IPTV internal IP), no NAT traversal configuration is needed.

### Huawei FCC Protocol

The Huawei FCC protocol natively supports NAT traversal and can work normally behind NAT without additional port forwarding configuration. The Huawei FCC protocol can only be used on Huawei IPTV platforms.

### Telecom FCC Protocol

If you are using the Telecom/ZTE/FiberHome FCC protocol, you need to configure port forwarding for FCC to work properly.

Almost all IPTV platforms (including Huawei) support the Telecom FCC protocol.

In addition, you also need to configure IGMP/multicast forwarding (`igmpproxy` / `omcproxy`) on the upstream router to receive multicast streams normally.

#### Configuration

Please first manually specify `--fcc-listen-port-range`:

```bash
# Command line
rtp2httpd --fcc-listen-port-range 40000-40100

# Configuration file
[global]
fcc-listen-port-range = 40000-40100
```

Then you need to configure port forwarding on the upstream router to forward this port range (e.g., `40000-40100`) to the device running rtp2httpd.

> [!TIP]
> If your environment requires NAT traversal and the FCC server supports both protocols, it is recommended to use the Huawei FCC protocol (port 8027) first, which can save port forwarding configuration.

## Testing if FCC Works

1. **Use a fast-starting player**: Ensure the player itself starts fast enough and does not become a bottleneck, such as the [built-in web player](/en/guide/web-player).

2. **Observe channel switching speed**:

   - FCC enabled: Channel switching delay < 1s
   - FCC not enabled: Channel switching delay 2-5 seconds

3. **Check logs**:

   - `FCC: Unicast stream started successfully` indicates that the FCC address is valid and the unicast stream was successfully received.
   - `FCC: Server response timeout (80 ms), falling back to multicast` has two possible causes:
     1. The FCC address is invalid.
     2. Your network configuration is incorrect, preventing connection to the FCC server. Generally, you must obtain an IPTV internal IP via DHCP/IPoE/PPPoE and enable the rtp2httpd `--upstream-interface-fcc` or `--upstream-interface` option to specify the IPTV interface before you can access FCC. Please use tools such as ping/traceroute to diagnose.

## Related Documentation

- [China FCC Address Collection](/en/reference/cn-fcc-collection): FCC server addresses for various provinces in China
- [URL Format Specification](/en/guide/url-formats): FCC URL format
- [Configuration Reference](/en/reference/configuration): FCC-related configuration parameters
