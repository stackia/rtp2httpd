# FCC Address Collection (China)

The following FCC (Fast Channel Change) server addresses were collected from the Internet for various regions in China. Availability is not guaranteed. Please report issues at <https://github.com/stackia/rtp2httpd/issues/5>.

> [!TIP]
>
> 1. If your city is not listed, try addresses from nearby cities or the provincial capital.
> 2. In some regions, the FCC IP is the same as the RTSP unicast source IP, only the port differs. If you can find the local RTSP unicast address, try changing the port to 8027 or 15970 to use as the FCC address.
> 3. Check rtp2httpd logs to determine if FCC is working.
>    - `FCC: Unicast stream started successfully` indicates the FCC address is valid and unicast stream is received successfully.
>    - `FCC: Server response timeout (80 ms), falling back to multicast` has two possible causes:
>      1. The FCC address is invalid.
>      2. Your network configuration is incorrect, preventing connection to the FCC server. Generally, you need to obtain an IPTV internal IP via DHCP/IPoE/PPPoE and enable the rtp2httpd `--upstream-interface-fcc` or `--upstream-interface` option to specify the IPTV interface. Use ping/traceroute tools to diagnose.
> 4. In some regions, different multicast addresses may require different FCC IPs, and some multicast channels may not have FCC enabled.
> 5. Some regions have multiple IPTV platforms (ZTE, Huawei, FiberHome, etc.) from the same ISP, which may have different FCC addresses. User A and User B in the same region may experience different results if they are on different IPTV platforms.
>    - Typically, port 8027 is used by Huawei platforms, port 15970 by ZTE/FiberHome platforms

## Hainan

- China Telecom: `10.255.75.73:15970`

## Jiangsu

- China Telecom: `180.100.72.185:15970`

## Zhejiang

- China Telecom:
  - `115.233.40.137:8027` (Hangzhou)
  - `115.233.41.137:8027` (Hangzhou)
  - `220.186.210.205:8027` (Wenzhou)
  - `115.233.43.70:8027` (Jinhua)
  - `220.191.136.24:8027` (Taizhou)
  - `115.233.42.69:8027` (Shaoxing)
  - `202.101.181.109:8027` (Quzhou)

## Shanghai

- China Telecom:
  - `124.75.26.151:15970`
  - `124.75.25.211:7777`
  - `124.75.25.214:7777`
  - `124.75.25.212:7777`
  - `124.75.25.215:7777`
  - `124.75.25.216:7777`
- China Unicom: `10.223.3.189:8027`

## Tianjin

- China Telecom: `10.255.4.140:8027`
- China Mobile: `10.206.255.108:8027`

## Hunan

- China Telecom:
  - `10.255.168.4:15970`
  - `124.232.149.47:15970`
  - `61.150.161.42:8027`
  - `222.241.55.41:8027` (Changde)
- China Mobile: `100.127.255.233:15970`

## Hubei

- China Telecom: `121.60.255.120:15970`

## Henan

- China Unicom:
  - `10.254.199.130:8027` (Zhengzhou)
  - `10.254.185.70:15970`

## Hebei

- China Telecom: `192.168.30.150:8027`
- China Unicom:
  - `10.7.50.172:8027` (Tangshan)
  - `10.7.35.172:8027` (Qinhuangdao)

## Shandong

- China Telecom: `150.138.8.132:8027` (Qingdao)
- China Unicom:
  - `124.132.240.66:15970`
  - `61.156.103.83:8027` (Qingdao)
  - `119.184.120.108:8027` (Rizhao)

## Shanxi

- China Telecom: `10.56.17.68:8027`
- China Unicom: `10.112.7.159:8027`

## Shaanxi

- China Telecom:
  - `113.136.29.140:8027` (Xi'an)
  - `113.136.242.134:8027` (Xi'an)

## Guangdong

- China Telecom:
  - `183.59.156.166:8027` (Guangzhou)
  - `183.59.160.61:8027` (Shenzhen)
  - `183.59.168.166:8027` (Dongguan)

## Guangxi

- China Telecom:
  - `180.141.207.228:8027`
  - `180.141.206.228:8027`
  - `113.15.79.82:8027`
  - `171.104.238.90:8027` (Liuzhou)
  - `10.255.136.86:8027` (Liuzhou)
  - `10.255.165.82:8027` (Fangchenggang)

## Sichuan

- China Telecom:
  - `182.139.234.40:8027` (Chengdu)
  - `182.139.229.78:8027` (Chengdu)
  - `220.167.81.247:8027` (Chengdu)
  - `118.123.55.74:8027` (Chengdu)
  - `118.119.188.42:8027` (Emeishan)
  - `118.119.178.42:8027` (Leshan)
  - `182.128.24.170:8027` (Guangyuan)
- China Mobile: `183.223.164.65:8027`

## Chongqing

- China Telecom:
  - `172.23.35.216:15970` (Yongchuan)
  - `172.23.2.138:8027` (Dazu)
- China Unicom: `123.147.117.148:15970`
- China Mobile: `172.16.4.155:8027`

## Guizhou

- China Telecom:
  - `10.255.133.132:15970`
  - `10.255.5.32:8027`
- China Mobile: `117.187.29.36:15970` (Qiannan)

## Anhui

- China Telecom: `117.71.18.200:15970`

## Liaoning

- China Telecom:
  - `10.255.128.136:8027` (Shenyang)
  - `10.255.132.132:15970` (Shenyang)
- China Unicom: `218.24.21.133:15970`

## Jilin

- China Mobile: `111.26.238.155:8027`

## Gansu

- China Telecom: `125.76.62.60:8027`

## Qinghai

- China Telecom:
  - `125.72.115.252:158`
  - `125.72.108.212:15970` (Xining)
