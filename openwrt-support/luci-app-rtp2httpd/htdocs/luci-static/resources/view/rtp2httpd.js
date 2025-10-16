"use strict";
"require form";
"require view";
"require tools.widgets as widgets";
"require fs";
"require uci";

return view.extend({
  render: function () {
    var m, s, o;

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
      return Promise.all([
        uci.load("rtp2httpd"),
        fs.read("/etc/rtp2httpd.conf").catch(function () {
          return "";
        }),
      ]).then(function (results) {
        var port = "5140"; // default port
        var token = null;
        var statusPath = "/status"; // default status page path
        var use_config_file = uci.get(
          "rtp2httpd",
          section_id,
          "use_config_file"
        );

        if (use_config_file === "1") {
          // Parse port, token and status-page-path from config file content
          var configContent = results[1];
          var portMatch = configContent.match(/^\s*\*\s+(\d+)\s*$/m);
          if (!portMatch) {
            // Try alternative format: hostname port
            portMatch = configContent.match(/^\s*[^\s]+\s+(\d+)\s*$/m);
          }
          if (portMatch && portMatch[1]) {
            port = portMatch[1];
          }
          // Parse r2h-token from config file
          var tokenMatch = configContent.match(
            /^\s*r2h-token\s*=?\s*(.+?)\s*$/m
          );
          if (tokenMatch && tokenMatch[1]) {
            token = tokenMatch[1];
          }
          // Parse status-page-path from config file
          var statusPathMatch = configContent.match(
            /^\s*status-page-path\s*=?\s*(.+?)\s*$/m
          );
          if (statusPathMatch && statusPathMatch[1]) {
            statusPath = statusPathMatch[1];
          }
        } else {
          // Get port, token and status_page_path from UCI config
          port = uci.get("rtp2httpd", section_id, "port") || "5140";
          token = uci.get("rtp2httpd", section_id, "r2h_token");
          statusPath =
            uci.get("rtp2httpd", section_id, "status_page_path") || "/status";
        }

        // Ensure statusPath starts with /
        if (statusPath && !statusPath.startsWith("/")) {
          statusPath = "/" + statusPath;
        }

        var statusUrl =
          "http://" + window.location.hostname + ":" + port + statusPath;
        if (token) {
          statusUrl += "?r2h-token=" + encodeURIComponent(token);
        }
        window.open(statusUrl, "_blank");
      });
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
    o.value("0", _("rtp2httpd_Quiet"));
    o.value("1", _("rtp2httpd_Error"));
    o.value("2", _("rtp2httpd_Warn"));
    o.value("3", _("rtp2httpd_Info"));
    o.value("4", _("rtp2httpd_Debug"));
    o.default = "1";
    o.depends("use_config_file", "0");

    o = s.option(
      widgets.DeviceSelect,
      "upstream_interface_unicast",
      _("rtp2httpd_Upstream Unicast Interface"),
      _(
        "rtp2httpd_Interface_unicast to use for requesting unicast upstream media stream (default none, which follows the routing table)"
      )
    );
    o.noaliases = true;
    o.datatype = "interface";
    o.depends("use_config_file", "0");

    o = s.option(
      widgets.DeviceSelect,
      "upstream_interface_multicast",
      _("rtp2httpd_Upstream Multicast Interface"),
      _(
        "rtp2httpd_Interface_multicast to use for requesting multicast upstream media stream (default none, which follows the routing table)"
      )
    );
    o.noaliases = true;
    o.datatype = "interface";
    o.depends("use_config_file", "0");

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
      _("rtp2httpd_Hostname to check in the Host: HTTP header")
    );
    o.datatype = "hostname";
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
      "r2h_token",
      _("rtp2httpd_R2H Token"),
      _("rtp2httpd_Authentication token for HTTP requests")
    );
    o.password = true;
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
      form.ListValue,
      "fcc_nat_traversal",
      _("rtp2httpd_FCC NAT traversal"),
      _("rtp2httpd_Only needed when used as a downstream router")
    );
    o.value("0", _("rtp2httpd_Don't use NAT traversal"));
    o.value("1", _("rtp2httpd_NAT punch hole"));
    o.value("2", _("rtp2httpd_NAT-PMP"));
    o.default = "0";
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

    return m.render();
  },
});
