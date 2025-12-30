"use strict";
"require form";
"require view";
"require tools.widgets as widgets";
"require fs";
"require uci";

return view.extend({
  // Helper function to open a page (status or player)
  openPage: function (section_id, pageType) {
    var pathConfigKey =
      pageType === "status" ? "status-page-path" : "player-page-path";
    var uciPathKey =
      pageType === "status" ? "status_page_path" : "player_page_path";
    var defaultPath = pageType === "status" ? "/status" : "/player";

    return Promise.all([
      uci.load("rtp2httpd"),
      fs.read("/etc/rtp2httpd.conf").catch(function () {
        return "";
      }),
    ]).then(function (results) {
      var port = "5140"; // default port
      var token = null;
      var pagePath = defaultPath;
      var hostname = null;
      var use_config_file = uci.get("rtp2httpd", section_id, "use_config_file");

      if (use_config_file === "1") {
        // Parse port, token, hostname and page path from config file content
        var configContent = results[1];
        var portMatch = configContent.match(/^\s*\*\s+(\d+)\s*$/m);
        if (!portMatch) {
          // Try alternative format: hostname port
          portMatch = configContent.match(/^\s*[^\s]+\s+(\d+)\s*$/m);
        }
        if (portMatch && portMatch[1]) {
          port = portMatch[1];
        }
        // Parse hostname from config file
        var hostnameMatch = configContent.match(
          /^\s*hostname\s*=?\s*(.+?)\s*$/m
        );
        if (hostnameMatch && hostnameMatch[1]) {
          hostname = hostnameMatch[1];
        }
        // Parse r2h-token from config file
        var tokenMatch = configContent.match(/^\s*r2h-token\s*=?\s*(.+?)\s*$/m);
        if (tokenMatch && tokenMatch[1]) {
          token = tokenMatch[1];
        }
        // Parse page path from config file
        var pagePathRegex = new RegExp(
          "^\\s*" + pathConfigKey + "\\s*=?\\s*(.+?)\\s*$",
          "m"
        );
        var pagePathMatch = configContent.match(pagePathRegex);
        if (pagePathMatch && pagePathMatch[1]) {
          pagePath = pagePathMatch[1];
        }
      } else {
        // Get port, token, hostname and page path from UCI config
        port = uci.get("rtp2httpd", section_id, "port") || "5140";
        token = uci.get("rtp2httpd", section_id, "r2h_token");
        hostname = uci.get("rtp2httpd", section_id, "hostname");
        pagePath = uci.get("rtp2httpd", section_id, uciPathKey) || defaultPath;
      }

      // Ensure pagePath starts with /
      if (pagePath && !pagePath.startsWith("/")) {
        pagePath = "/" + pagePath;
      }

      // Use configured hostname or fallback to window.location.hostname
      var targetHostname = hostname || window.location.hostname;

      // If hostname doesn't have protocol, prepend http:// for URL parsing
      var hasProtocol = /^https?:\/\//i.test(targetHostname);
      var urlToParse = hasProtocol
        ? targetHostname
        : "http://" + targetHostname;

      var url;
      try {
        url = new URL(urlToParse);
      } catch (e) {
        // Fallback if URL parsing fails
        var fallbackUrl = "http://" + targetHostname + ":" + port + pagePath;
        if (token) {
          fallbackUrl += "?r2h-token=" + encodeURIComponent(token);
        }
        window.open(fallbackUrl, "_blank");
        return;
      }

      // Build URL following get_server_address logic:
      // 1. If no protocol was in original hostname, use configured port
      // 2. If protocol was present, keep the port from URL (if any)
      var finalProtocol = url.protocol.replace(":", "");
      var finalHost = url.hostname;
      var finalPort = "";

      if (!hasProtocol) {
        // No protocol in original hostname: use configured port if URL port is empty
        if (!url.port) {
          finalPort = port;
        } else {
          finalPort = url.port;
        }
      } else {
        // Protocol was present: keep URL's port (may be empty)
        finalPort = url.port;
      }

      // Build base URL: protocol://host[:port]
      // Omit port if it's default (http:80 or https:443) or empty
      var pageUrl;
      if (
        !finalPort ||
        (finalProtocol === "http" && finalPort === "80") ||
        (finalProtocol === "https" && finalPort === "443")
      ) {
        pageUrl = finalProtocol + "://" + finalHost;
      } else {
        pageUrl = finalProtocol + "://" + finalHost + ":" + finalPort;
      }

      // Add base path from hostname if present
      var basePath = url.pathname;
      if (basePath && basePath !== "/") {
        // Ensure base path ends with '/'
        if (!basePath.endsWith("/")) {
          pageUrl += basePath + "/";
        } else {
          pageUrl += basePath;
        }
        // Remove leading slash from pagePath to avoid double slash
        if (pagePath.startsWith("/")) {
          pagePath = pagePath.substring(1);
        }
      }

      // Add the page path
      pageUrl += pagePath;

      // Add token if present
      if (token) {
        pageUrl += "?r2h-token=" + encodeURIComponent(token);
      }

      window.open(pageUrl, "_blank");
    });
  },

  render: function () {
    var m, s, o;
    var self = this;

    m = new form.Map(
      "rtp2httpd",
      _("rtp2httpd"),
      _(
        "rtp2httpd converts RTP/UDP/RTSP media into http stream. Here you can configure the settings."
      )
    );

    s = m.section(form.TypedSection, "rtp2httpd");
    s.anonymous = true;
    s.addremove = true;

    // Create tabs
    s.tab("basic", _("Basic Settings"));
    s.tab("network", _("Network & Performance"));
    s.tab("player", _("Player & M3U"));
    s.tab("advanced", _("Monitoring & Advanced"));

    // ===== TAB 1: Basic Settings =====
    o = s.taboption("basic", form.Flag, "disabled", _("Enabled"));
    o.enabled = "0";
    o.disabled = "1";
    o.default = o.enabled;
    o.rmempty = false;

    o = s.taboption(
      "basic",
      form.Flag,
      "respawn",
      _("Respawn"),
      _("Auto restart after crash")
    );
    o.default = "1";

    // Add "Use Config File" option
    o = s.taboption(
      "basic",
      form.Flag,
      "use_config_file",
      _("Use Config File"),
      _("Use config file instead of individual options")
    );
    o.default = "0";

    // Config file editor
    o = s.taboption(
      "basic",
      form.TextValue,
      "config_file_content",
      _("Config File Content"),
      _("Edit the content of /etc/rtp2httpd.conf")
    );
    o.rows = 40;
    o.cols = 80;
    o.monospace = true;
    o.depends("use_config_file", "1");
    o.load = function (section_id) {
      return fs
        .read("/etc/rtp2httpd.conf")
        .then(function (content) {
          return content || "";
        })
        .catch(function () {
          return "";
        });
    };
    o.write = function (section_id, value) {
      return fs.write("/etc/rtp2httpd.conf", value || "").then(function () {
        // Trigger service restart by touching a UCI value
        return uci.set(
          "rtp2httpd",
          section_id,
          "config_update_time",
          Date.now().toString()
        );
      });
    };

    o = s.taboption("basic", form.Value, "port", _("Port"));
    o.datatype = "port";
    o.placeholder = "5140";
    o.depends("use_config_file", "0");

    o = s.taboption("basic", form.ListValue, "verbose", _("Logging level"));
    o.value("0", "Fatal");
    o.value("1", "Error");
    o.value("2", "Warn");
    o.value("3", "Info");
    o.value("4", "Debug");
    o.default = "1";
    o.depends("use_config_file", "0");

    // ===== TAB 2: Network & Performance =====
    // Add "Advanced Interface Settings" option
    o = s.taboption(
      "network",
      form.Flag,
      "advanced_interface_settings",
      _("Advanced Interface Settings"),
      _("Configure separate interfaces for multicast, FCC and RTSP")
    );
    o.default = "0";
    o.depends("use_config_file", "0");

    // Simple interface setting (when advanced is disabled)
    o = s.taboption(
      "network",
      widgets.DeviceSelect,
      "upstream_interface",
      _("Upstream Interface"),
      _(
        "Default interface for all upstream traffic (multicast, FCC and RTSP). Leave empty to use routing table."
      )
    );
    o.noaliases = true;
    o.datatype = "interface";
    o.depends({ use_config_file: "0", advanced_interface_settings: "0" });

    // Advanced interface settings (when advanced is enabled)
    o = s.taboption(
      "network",
      widgets.DeviceSelect,
      "upstream_interface_multicast",
      _("Upstream Multicast Interface"),
      _(
        "Interface to use for multicast (RTP/UDP) upstream media stream (default: use routing table)"
      )
    );
    o.noaliases = true;
    o.datatype = "interface";
    o.depends({ use_config_file: "0", advanced_interface_settings: "1" });

    o = s.taboption(
      "network",
      widgets.DeviceSelect,
      "upstream_interface_fcc",
      _("Upstream FCC Interface"),
      _(
        "Interface to use for FCC unicast upstream media stream (default: use routing table)"
      )
    );
    o.noaliases = true;
    o.datatype = "interface";
    o.depends({ use_config_file: "0", advanced_interface_settings: "1" });

    o = s.taboption(
      "network",
      widgets.DeviceSelect,
      "upstream_interface_rtsp",
      _("Upstream RTSP Interface"),
      _(
        "Interface to use for RTSP unicast upstream media stream (default: use routing table)"
      )
    );
    o.noaliases = true;
    o.datatype = "interface";
    o.depends({ use_config_file: "0", advanced_interface_settings: "1" });

    o = s.taboption(
      "network",
      form.Value,
      "maxclients",
      _("Max clients allowed")
    );
    o.datatype = "range(1, 5000)";
    o.placeholder = "5";
    o.depends("use_config_file", "0");

    o = s.taboption(
      "network",
      form.Value,
      "workers",
      _("Workers"),
      _(
        "Number of worker processes. Set to 1 for resource-constrained devices, or CPU cores for best performance."
      )
    );
    o.datatype = "range(1, 64)";
    o.placeholder = "1";
    o.depends("use_config_file", "0");

    o = s.taboption(
      "network",
      form.Value,
      "buffer_pool_max_size",
      _("Buffer Pool Max Size"),
      _(
        "Maximum number of buffers in zero-copy pool. Each buffer is 1536 bytes. Default is 16384 (~24MB). Increase to improve throughput for multi-client concurrency."
      )
    );
    o.datatype = "range(1024, 1048576)";
    o.placeholder = "16384";
    o.depends("use_config_file", "0");

    o = s.taboption(
      "network",
      form.Value,
      "mcast_rejoin_interval",
      _("Multicast Rejoin Interval"),
      _(
        "Periodic multicast rejoin interval in seconds (0=disabled, default 0). Enable this (e.g., 30-120 seconds) if your network switches timeout multicast memberships due to missing IGMP Query messages. Only use when experiencing multicast stream interruptions."
      )
    );
    o.datatype = "range(0, 86400)";
    o.placeholder = "0";
    o.depends("use_config_file", "0");

    o = s.taboption(
      "network",
      form.Value,
      "fcc_listen_port_range",
      _("FCC Listen Port Range"),
      _(
        "Local UDP port range for FCC client sockets (format: start-end, e.g., 40000-40100). Leave empty to use random ports."
      )
    );
    o.placeholder = "begin-end";
    o.depends("use_config_file", "0");

    o = s.taboption(
      "network",
      form.Flag,
      "zerocopy_on_send",
      _("Zero-Copy on Send"),
      _(
        "Enable zero-copy send with MSG_ZEROCOPY for better performance. Requires kernel 4.14+ (MSG_ZEROCOPY support). On supported devices, this can improve throughput and reduce CPU usage, especially under high concurrent load. Recommended only when experiencing performance bottlenecks."
      )
    );
    o.default = "0";
    o.depends("use_config_file", "0");

    // ===== TAB 3: Player & M3U =====
    o = s.taboption(
      "player",
      form.Value,
      "external_m3u",
      _("External M3U"),
      _(
        "Fetch M3U playlist from a URL (file://, http://, https:// supported). Example: https://example.com/playlist.m3u or file:///path/to/playlist.m3u"
      )
    );
    o.placeholder = "https://example.com/playlist.m3u";
    o.depends("use_config_file", "0");

    o = s.taboption(
      "player",
      form.Value,
      "external_m3u_update_interval",
      _("External M3U Update Interval"),
      _(
        "External M3U automatic update interval in seconds (default: 7200 = 2 hours). Set to 0 to disable automatic updates."
      )
    );
    o.datatype = "uinteger";
    o.placeholder = "7200";
    o.depends("use_config_file", "0");

    o = s.taboption(
      "player",
      form.Value,
      "player_page_path",
      _("Player Page Path"),
      _("URL path for the player page (default: /player)")
    );
    o.placeholder = "/player";
    o.depends("use_config_file", "0");

    // Warning message when M3U is not configured
    o = s.taboption("player", form.DummyValue, "_player_warning");
    o.rawhtml = true;
    o.default =
      '<div class="alert-message warning">' +
      _(
        "Note: The player page requires External M3U URL to be configured first."
      ) +
      "</div>";
    o.depends({ use_config_file: "0", external_m3u: "" });

    // Player page button with M3U validation
    o = s.taboption("player", form.Button, "_player_page", _("Player Page"));
    o.inputtitle = _("Open Player Page");
    o.inputstyle = "apply";
    o.onclick = function (ev, section_id) {
      return uci.load("rtp2httpd").then(function () {
        var use_config_file = uci.get(
          "rtp2httpd",
          section_id,
          "use_config_file"
        );

        // In config file mode, skip M3U validation (user manages config freely)
        if (use_config_file === "1") {
          return self.openPage(section_id, "player");
        }

        // In UCI mode, validate M3U is configured
        var m3u = uci.get("rtp2httpd", section_id, "external_m3u");
        if (!m3u || m3u.trim() === "") {
          alert(_("Please configure External M3U URL first"));
          return;
        }
        return self.openPage(section_id, "player");
      });
    };

    // ===== TAB 4: Monitoring & Advanced =====
    o = s.taboption(
      "advanced",
      form.Button,
      "_status_dashboard",
      _("Status Dashboard")
    );
    o.inputtitle = _("Open Status Dashboard");
    o.inputstyle = "apply";
    o.onclick = function (ev, section_id) {
      return self.openPage(section_id, "status");
    };

    o = s.taboption(
      "advanced",
      form.Value,
      "status_page_path",
      _("Status Page Path"),
      _("URL path for the status page (default: /status)")
    );
    o.placeholder = "/status";
    o.depends("use_config_file", "0");

    o = s.taboption(
      "advanced",
      form.Value,
      "hostname",
      _("Hostname"),
      _(
        "When configured, HTTP Host header will be checked and must match this value to allow access."
      )
    );
    o.depends("use_config_file", "0");

    o = s.taboption(
      "advanced",
      form.Value,
      "r2h_token",
      _("R2H Token"),
      _(
        "If set, all HTTP requests must include r2h-token query parameter with matching value (e.g., http://server:port/rtp/ip:port?fcc=ip:port&r2h-token=your-token)"
      )
    );
    o.depends("use_config_file", "0");

    o = s.taboption(
      "advanced",
      form.Flag,
      "xff",
      _("X-Forwarded-For"),
      _(
        "When enabled, uses HTTP X-Forwarded-For header as client address for status page display. Also accepts X-Forwarded-Host / X-Forwarded-Proto headers as the base URL for M3U playlist conversion. Only enable when running behind a reverse proxy."
      )
    );
    o.default = "0";
    o.depends("use_config_file", "0");

    o = s.taboption(
      "advanced",
      form.Flag,
      "video_snapshot",
      _("Video Snapshot"),
      _(
        "Enable video snapshot feature. When enabled, clients can request snapshots with snapshot=1 query parameter"
      )
    );
    o.default = "0";
    o.depends("use_config_file", "0");

    o = s.taboption(
      "advanced",
      form.Value,
      "ffmpeg_path",
      _("FFmpeg Path"),
      _(
        "Path to FFmpeg executable. Leave empty to use system PATH (default: ffmpeg)"
      )
    );
    o.placeholder = "ffmpeg";
    o.depends({ use_config_file: "0", video_snapshot: "1" });

    o = s.taboption(
      "advanced",
      form.Value,
      "ffmpeg_args",
      _("FFmpeg Arguments"),
      _(
        "Additional FFmpeg arguments for snapshot generation. Common options: -hwaccel none, -hwaccel auto, -hwaccel vaapi (for Intel GPU)"
      )
    );
    o.placeholder = "-hwaccel none";
    o.depends({ use_config_file: "0", video_snapshot: "1" });

    return m.render();
  },
});
