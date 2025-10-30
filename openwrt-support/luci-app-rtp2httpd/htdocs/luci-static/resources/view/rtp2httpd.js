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
      var urlToParse = hasProtocol ? targetHostname : "http://" + targetHostname;

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
        "rtp2httpd converts multicast RTP/UDP media into http stream. Here you can configure the settings."
      )
    );

    s = m.section(form.TypedSection, "rtp2httpd");
    s.anonymous = true;
    s.addremove = true;

    o = s.option(form.Flag, "disabled", _("rtp2httpd_Enabled"));
    o.enabled = "0";
    o.disabled = "1";
    o.default = o.enabled;
    o.rmempty = false;

    o = s.option(
      form.Flag,
      "respawn",
      _("rtp2httpd_Respawn"),
      _("rtp2httpd_Auto restart after crash")
    );
    o.default = "0";

    o = s.option(
      form.Button,
      "_status_dashboard",
      _("rtp2httpd_Status Dashboard")
    );
    o.inputtitle = _("rtp2httpd_Open Status Dashboard");
    o.inputstyle = "apply";
    o.onclick = function (ev, section_id) {
      return self.openPage(section_id, "status");
    };

    o = s.option(form.Button, "_player_page", _("rtp2httpd_Player Page"));
    o.inputtitle = _("rtp2httpd_Open Player Page");
    o.inputstyle = "apply";
    o.onclick = function (ev, section_id) {
      return self.openPage(section_id, "player");
    };

    // Add "Use Config File" option
    o = s.option(
      form.Flag,
      "use_config_file",
      _("rtp2httpd_Use Config File"),
      _("rtp2httpd_Use config file instead of individual options")
    );
    o.default = "0";

    // Config file editor
    o = s.option(
      form.TextValue,
      "config_file_content",
      _("rtp2httpd_Config File Content"),
      _("rtp2httpd_Edit the content of /etc/rtp2httpd.conf")
    );
    o.rows = 40;
    o.cols = 80;
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

    o = s.option(form.Value, "port", _("rtp2httpd_Port"));
    o.datatype = "port";
    o.default = "5140";
    o.depends("use_config_file", "0");

    o = s.option(form.ListValue, "verbose", _("rtp2httpd_Verbose"));
    o.value("0", _("rtp2httpd_Fatal"));
    o.value("1", _("rtp2httpd_Error"));
    o.value("2", _("rtp2httpd_Warn"));
    o.value("3", _("rtp2httpd_Info"));
    o.value("4", _("rtp2httpd_Debug"));
    o.default = "1";
    o.depends("use_config_file", "0");

    // Add "Advanced Interface Settings" option
    o = s.option(
      form.Flag,
      "advanced_interface_settings",
      _("rtp2httpd_Advanced Interface Settings"),
      _("rtp2httpd_Configure separate interfaces for multicast, FCC and RTSP")
    );
    o.default = "0";
    o.depends("use_config_file", "0");

    // Simple interface setting (when advanced is disabled)
    o = s.option(
      widgets.DeviceSelect,
      "upstream_interface",
      _("rtp2httpd_Upstream Interface"),
      _(
        "rtp2httpd_Default interface for all upstream traffic (multicast, FCC and RTSP). Leave empty to use routing table."
      )
    );
    o.noaliases = true;
    o.datatype = "interface";
    o.depends({ use_config_file: "0", advanced_interface_settings: "0" });

    // Advanced interface settings (when advanced is enabled)
    o = s.option(
      widgets.DeviceSelect,
      "upstream_interface_multicast",
      _("rtp2httpd_Upstream Multicast Interface"),
      _(
        "rtp2httpd_Interface to use for multicast (RTP/UDP) upstream media stream (default: use routing table)"
      )
    );
    o.noaliases = true;
    o.datatype = "interface";
    o.depends({ use_config_file: "0", advanced_interface_settings: "1" });

    o = s.option(
      widgets.DeviceSelect,
      "upstream_interface_fcc",
      _("rtp2httpd_Upstream FCC Interface"),
      _(
        "rtp2httpd_Interface to use for FCC unicast upstream media stream (default: use routing table)"
      )
    );
    o.noaliases = true;
    o.datatype = "interface";
    o.depends({ use_config_file: "0", advanced_interface_settings: "1" });

    o = s.option(
      widgets.DeviceSelect,
      "upstream_interface_rtsp",
      _("rtp2httpd_Upstream RTSP Interface"),
      _(
        "rtp2httpd_Interface to use for RTSP unicast upstream media stream (default: use routing table)"
      )
    );
    o.noaliases = true;
    o.datatype = "interface";
    o.depends({ use_config_file: "0", advanced_interface_settings: "1" });

    o = s.option(form.Value, "maxclients", _("rtp2httpd_Max clients"));
    o.datatype = "range(1, 5000)";
    o.default = "5";
    o.depends("use_config_file", "0");

    o = s.option(
      form.Value,
      "workers",
      _("rtp2httpd_Workers"),
      _(
        "rtp2httpd_Number of worker processes (SO_REUSEPORT sharded). Set to CPU cores for best perf."
      )
    );
    o.datatype = "range(1, 64)";
    o.placeholder = "1";
    o.depends("use_config_file", "0");

    o = s.option(
      form.Value,
      "buffer_pool_max_size",
      _("rtp2httpd_Buffer Pool Max Size"),
      _(
        "rtp2httpd_Maximum number of buffers in zero-copy pool. Each buffer is 1536 bytes. Increase to improve throughput for multi-client concurrency."
      )
    );
    o.datatype = "range(1024, 1048576)";
    o.placeholder = "16384";
    o.depends("use_config_file", "0");

    o = s.option(
      form.Value,
      "hostname",
      _("rtp2httpd_Hostname"),
      _("rtp2httpd_Hostname description")
    );
    o.depends("use_config_file", "0");

    o = s.option(
      form.Flag,
      "xff",
      _("rtp2httpd_xff"),
      _(
        "rtp2httpd_Enable X-Forwarded-For header recognize"
      )
    );
    o.default = "0";
    o.depends("use_config_file", "0");

    o = s.option(
      form.Value,
      "status_page_path",
      _("rtp2httpd_Status Page Path"),
      _("rtp2httpd_Status page path description")
    );
    o.placeholder = "/status";
    o.depends("use_config_file", "0");

    o = s.option(
      form.Value,
      "player_page_path",
      _("rtp2httpd_Player Page Path"),
      _("rtp2httpd_Player page path description")
    );
    o.placeholder = "/player";
    o.depends("use_config_file", "0");

    o = s.option(
      form.Value,
      "r2h_token",
      _("rtp2httpd_R2H Token"),
      _("rtp2httpd_Authentication token for HTTP requests")
    );
    o.password = true;
    o.depends("use_config_file", "0");

    o = s.option(
      form.Value,
      "external_m3u",
      _("rtp2httpd_External M3U"),
      _("rtp2httpd_External M3U description")
    );
    o.placeholder = "https://example.com/playlist.m3u";
    o.depends("use_config_file", "0");

    o = s.option(
      form.Value,
      "external_m3u_update_interval",
      _("rtp2httpd_External M3U Update Interval"),
      _("rtp2httpd_External M3U update interval description")
    );
    o.datatype = "uinteger";
    o.placeholder = "86400";
    o.depends("use_config_file", "0");

    o = s.option(
      form.Value,
      "mcast_rejoin_interval",
      _("rtp2httpd_Multicast Rejoin Interval"),
      _("rtp2httpd_Multicast rejoin interval description")
    );
    o.datatype = "range(0, 86400)";
    o.placeholder = "0";
    o.depends("use_config_file", "0");

    o = s.option(
      form.Value,
      "fcc_listen_port_range",
      _("rtp2httpd_FCC Listen Port Range"),
      _("rtp2httpd_FCC listen port range description")
    );
    o.placeholder = "40000-40100";
    o.depends("use_config_file", "0");

    o = s.option(
      form.Flag,
      "video_snapshot",
      _("rtp2httpd_Video Snapshot"),
      _("rtp2httpd_Video snapshot description")
    );
    o.default = "0";
    o.depends("use_config_file", "0");

    o = s.option(
      form.Value,
      "ffmpeg_path",
      _("rtp2httpd_FFmpeg Path"),
      _("rtp2httpd_FFmpeg path description")
    );
    o.placeholder = "ffmpeg";
    o.depends("use_config_file", "0");

    o = s.option(
      form.Value,
      "ffmpeg_args",
      _("rtp2httpd_FFmpeg Arguments"),
      _("rtp2httpd_FFmpeg arguments description")
    );
    o.placeholder = "-hwaccel none";
    o.depends("use_config_file", "0");

    o = s.option(
      form.Flag,
      "zerocopy_on_send",
      _("rtp2httpd_Zero-Copy on Send"),
      _(
        "rtp2httpd_Enable zero-copy send with MSG_ZEROCOPY for better performance. Requires kernel 4.14+. Can improve throughput and reduce CPU usage on supported devices."
      )
    );
    o.default = "0";
    o.depends("use_config_file", "0");

    return m.render();
  },
});
