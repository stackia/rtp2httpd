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
    o.default = "8080";
    o.depends("use_config_file", "0");

    o = s.option(form.ListValue, "verbose", _("rtp2httpd_Verbose"));
    o.value("0", _("rtp2httpd_Quiet"));
    o.value("1", _("rtp2httpd_Error"));
    o.value("2", _("rtp2httpd_Info"));
    o.value("3", _("rtp2httpd_Debug"));
    o.default = "1";
    o.depends("use_config_file", "0");

    o = s.option(
      widgets.DeviceSelect,
      "upstream_interface",
      _("rtp2httpd_Upstream Interface"),
      _(
        "rtp2httpd_Interface to use for requesting upstream media stream (default none, which follows the routing table)"
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
      "hostname",
      _("rtp2httpd_Hostname"),
      _("rtp2httpd_Hostname to check in the Host: HTTP header")
    );
    o.datatype = "hostname";
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

    return m.render();
  },
});
