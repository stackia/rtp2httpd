-- FCC (Fast Channel Change) Protocol Dissector for Wireshark
-- Based on RTCP Generic RTP Feedback format (RFC 4585)
--
-- Telecom Protocol Format (China Telecom):
-- FMT 2: Client Request
-- FMT 3: Server Response
-- FMT 4: Sync Notification
-- FMT 5: Termination Message
--
-- Huawei Protocol Format:
-- FMT 5: Client Request (RSR - Rapid Stream Request)
-- FMT 6: Server Response
-- FMT 8: Sync Notification
-- FMT 9: Termination Message (SCR - Stream Change Request)
-- NAT Packet: Special 8-byte NAT traversal packet (non-RTCP)

local fcc_proto = Proto("FCC", "Fast Channel Change Protocol")

-- Protocol fields
local f_version = ProtoField.uint8("fcc.version", "Version", base.DEC, nil, 0xC0)
local f_padding = ProtoField.uint8("fcc.padding", "Padding", base.DEC, nil, 0x20)
local f_fmt = ProtoField.uint8("fcc.fmt", "FMT (Feedback Message Type)", base.DEC, {
    -- Telecom FCC Protocol
    [2] = "Client Request (Telecom)",
    [3] = "Server Response (Telecom)",
    [4] = "Sync Notification (Telecom)",
    -- Huawei FCC Protocol
    [5] = "Client Request / Termination (Huawei RSR / Telecom Term)",
    [6] = "Server Response (Huawei)",
    [8] = "Sync Notification (Huawei)",
    [9] = "Termination (Huawei SCR)"
}, 0x1F)
local f_payload_type = ProtoField.uint8("fcc.pt", "Payload Type", base.DEC)
local f_length = ProtoField.uint16("fcc.length", "Length", base.DEC)
local f_sender_ssrc = ProtoField.uint32("fcc.sender_ssrc", "Sender SSRC", base.HEX)
local f_media_ssrc = ProtoField.ipv4("fcc.media_ssrc", "Media Source SSRC (IP)")

-- FMT 2: Telecom Client Request fields
local f_req_version = ProtoField.uint32("fcc.req.version", "FCI Version", base.DEC, nil, 0xFF000000)
local f_req_reserved = ProtoField.uint32("fcc.req.reserved", "Reserved", base.HEX, nil, 0x00FFFFFF)
local f_req_client_port = ProtoField.uint16("fcc.req.client_port", "FCC Client Port", base.DEC)
local f_req_mcast_port = ProtoField.uint16("fcc.req.mcast_port", "Multicast Group Port", base.DEC)
local f_req_mcast_ip = ProtoField.ipv4("fcc.req.mcast_ip", "Multicast Group IP")
local f_req_stb_id = ProtoField.bytes("fcc.req.stb_id", "STB ID", base.SPACE)

-- FMT 3: Telecom Server Response fields
local f_resp_result = ProtoField.uint8("fcc.resp.result", "Result Code", base.DEC, {
    [0] = "Success",
    [1] = "Error"
})
local f_resp_action = ProtoField.uint8("fcc.resp.action", "Action Code", base.DEC, {
    [0] = "Join Multicast Immediately",
    [1] = "Join Multicast Immediately",
    [2] = "Start Unicast Stream",
    [3] = "Redirect to New Server"
})
local f_resp_signal_port = ProtoField.uint16("fcc.resp.signal_port", "New Signal Port", base.DEC)
local f_resp_media_port = ProtoField.uint16("fcc.resp.media_port", "New Media Port", base.DEC)
local f_resp_reserved = ProtoField.uint16("fcc.resp.reserved", "Reserved", base.HEX)
local f_resp_new_ip = ProtoField.ipv4("fcc.resp.new_ip", "New Server IP")
local f_resp_valid_time = ProtoField.uint32("fcc.resp.valid_time", "Valid Time (seconds)", base.DEC)
local f_resp_speed = ProtoField.uint32("fcc.resp.speed", "Burst Speed (bps)", base.DEC)
local f_resp_speed_after_sync = ProtoField.uint32("fcc.resp.speed_after_sync", "Speed After Sync (bps)", base.DEC)

-- FMT 5 (Telecom): Termination fields
local f_term_stop_bit = ProtoField.uint8("fcc.term.stop_bit", "Stop Bit", base.DEC, {
    [0] = "Normal Termination",
    [1] = "Force Termination"
})
local f_term_reserved = ProtoField.uint8("fcc.term.reserved", "Reserved", base.HEX)
local f_term_seqn = ProtoField.uint16("fcc.term.seqn", "First Multicast Packet Sequence", base.DEC)

-- Huawei FMT 5: Client Request fields
local f_hw_req_reserved1 = ProtoField.bytes("fcc.hw.req.reserved1", "Reserved", base.SPACE)
local f_hw_req_local_ip = ProtoField.ipv4("fcc.hw.req.local_ip", "Local IP Address")
local f_hw_req_client_port = ProtoField.uint16("fcc.hw.req.client_port", "FCC Client Port", base.DEC)
local f_hw_req_flag = ProtoField.uint16("fcc.hw.req.flag", "Flag", base.HEX)
local f_hw_req_redirect_flag = ProtoField.uint32("fcc.hw.req.redirect_flag", "Redirect Support Flag", base.HEX)

-- Huawei FMT 6: Server Response fields
local f_hw_resp_result = ProtoField.uint8("fcc.hw.resp.result", "Result Code", base.DEC, {
    [0] = "Error",
    [1] = "Success",
    [2] = "Error"
})
local f_hw_resp_reserved1 = ProtoField.uint8("fcc.hw.resp.reserved1", "Reserved", base.HEX)
local f_hw_resp_type = ProtoField.uint16("fcc.hw.resp.type", "Response Type", base.DEC, {
    [1] = "No Unicast Needed",
    [2] = "Unicast Stream",
    [3] = "Redirect to New Server"
})
local f_hw_resp_reserved2 = ProtoField.bytes("fcc.hw.resp.reserved2", "Reserved", base.SPACE)
local f_hw_resp_nat_flag = ProtoField.uint8("fcc.hw.resp.nat_flag", "NAT Flag", base.HEX)
local f_hw_resp_reserved3 = ProtoField.uint8("fcc.hw.resp.reserved3", "Reserved", base.HEX)
local f_hw_resp_server_port = ProtoField.uint16("fcc.hw.resp.server_port", "Server Port", base.DEC)
local f_hw_resp_session_id = ProtoField.uint32("fcc.hw.resp.session_id", "Session ID", base.HEX)
local f_hw_resp_server_ip = ProtoField.ipv4("fcc.hw.resp.server_ip", "Server IP Address")

-- Huawei FMT 9: Termination fields
local f_hw_term_status = ProtoField.uint8("fcc.hw.term.status", "Status", base.DEC, {
    [1] = "Joined Multicast Successfully",
    [2] = "Error - Cannot Join Multicast"
})
local f_hw_term_reserved = ProtoField.uint8("fcc.hw.term.reserved", "Reserved", base.HEX)
local f_hw_term_seqn = ProtoField.uint16("fcc.hw.term.seqn", "First Multicast Sequence", base.DEC)

-- Huawei NAT Traversal Packet fields
local f_hw_nat_magic = ProtoField.uint16("fcc.hw.nat.magic", "Magic", base.HEX)
local f_hw_nat_reserved = ProtoField.uint16("fcc.hw.nat.reserved", "Reserved", base.HEX)
local f_hw_nat_session_id = ProtoField.uint32("fcc.hw.nat.session_id", "Session ID", base.HEX)

fcc_proto.fields = {
    f_version, f_padding, f_fmt, f_payload_type, f_length,
    f_sender_ssrc, f_media_ssrc,
    -- Telecom Client Request
    f_req_version, f_req_reserved, f_req_client_port, f_req_mcast_port, f_req_mcast_ip, f_req_stb_id,
    -- Telecom Server Response
    f_resp_result, f_resp_action, f_resp_signal_port, f_resp_media_port,
    f_resp_reserved, f_resp_new_ip, f_resp_valid_time, f_resp_speed, f_resp_speed_after_sync,
    -- Telecom Termination
    f_term_stop_bit, f_term_reserved, f_term_seqn,
    -- Huawei Client Request (FMT 5)
    f_hw_req_reserved1, f_hw_req_local_ip, f_hw_req_client_port, f_hw_req_flag, f_hw_req_redirect_flag,
    -- Huawei Server Response (FMT 6)
    f_hw_resp_result, f_hw_resp_reserved1, f_hw_resp_type, f_hw_resp_reserved2,
    f_hw_resp_nat_flag, f_hw_resp_reserved3, f_hw_resp_server_port, f_hw_resp_session_id, f_hw_resp_server_ip,
    -- Huawei Termination (FMT 9)
    f_hw_term_status, f_hw_term_reserved, f_hw_term_seqn,
    -- Huawei NAT Traversal
    f_hw_nat_magic, f_hw_nat_reserved, f_hw_nat_session_id
}

-- Helper function to format bitrate
local function format_bitrate(bps)
    if bps >= 1048576 then
        return string.format("%.2f Mbps", bps / 1048576.0)
    elseif bps >= 1024 then
        return string.format("%.2f Kbps", bps / 1024.0)
    else
        return string.format("%u bps", bps)
    end
end

-- Helper function to format IP address from uint32
local function format_ip(ip_uint)
    local b1 = bit.band(bit.rshift(ip_uint, 24), 0xFF)
    local b2 = bit.band(bit.rshift(ip_uint, 16), 0xFF)
    local b3 = bit.band(bit.rshift(ip_uint, 8), 0xFF)
    local b4 = bit.band(ip_uint, 0xFF)
    return string.format("%d.%d.%d.%d", b1, b2, b3, b4)
end

-- Dissector for Huawei NAT Traversal packets (non-RTCP format)
local function dissect_huawei_nat(buffer, pinfo, tree)
    pinfo.cols.protocol = "FCC-NAT"
    pinfo.cols.info = "FCC Huawei NAT Traversal"

    local subtree = tree:add(fcc_proto, buffer(), "Fast Channel Change Protocol (Huawei NAT)")

    local nat_tree = subtree:add(buffer(0, 8), "NAT Traversal Packet")
    nat_tree:add(f_hw_nat_magic, buffer(0, 2))
    nat_tree:add(f_hw_nat_reserved, buffer(2, 2))

    local session_id = buffer(4, 4):uint()
    nat_tree:add(f_hw_nat_session_id, buffer(4, 4))

    pinfo.cols.info:append(string.format(" (Session: 0x%08X)", session_id))

    return true
end

-- Main dissector function
function fcc_proto.dissector(buffer, pinfo, tree)
    local length = buffer:len()
    if length == 0 then return end

    -- Check for Huawei NAT traversal packet (8 bytes, magic 0x0003)
    if length == 8 then
        local magic = buffer(0, 2):uint()
        if magic == 0x0003 then
            return dissect_huawei_nat(buffer, pinfo, tree)
        end
    end

    pinfo.cols.protocol = "FCC"

    local subtree = tree:add(fcc_proto, buffer(), "Fast Channel Change Protocol")

    -- Parse common RTCP header
    local first_byte = buffer(0, 1):uint()
    local version = bit.rshift(bit.band(first_byte, 0xC0), 6)
    local padding = bit.rshift(bit.band(first_byte, 0x20), 5)
    local fmt = bit.band(first_byte, 0x1F)

    local pt = buffer(1, 1):uint()
    local pkt_length = buffer(2, 2):uint()
    local sender_ssrc = buffer(4, 4):uint()
    local media_ssrc = buffer(8, 4):uint()

    -- Add common header fields
    subtree:add(f_version, buffer(0, 1), version)
    subtree:add(f_padding, buffer(0, 1), padding)
    subtree:add(f_fmt, buffer(0, 1), fmt)
    subtree:add(f_payload_type, buffer(1, 1))
    subtree:add(f_length, buffer(2, 2))
    subtree:add(f_sender_ssrc, buffer(4, 4))
    subtree:add(f_media_ssrc, buffer(8, 4))

    -- Check if this is an FCC packet (PT should be 205 for Generic RTP Feedback)
    if pt ~= 205 then
        return
    end

    -- Parse FCI (Feedback Control Information) based on FMT
    if fmt == 2 then
        -- Telecom Client Request (FMT 2)
        pinfo.cols.info = "FCC Client Request (Telecom)"

        if length >= 40 then
            local fci_tree = subtree:add(buffer(12, 28), "FCI: Client Request")

            fci_tree:add(f_req_version, buffer(12, 4))
            fci_tree:add(f_req_reserved, buffer(12, 4))

            local client_port = buffer(16, 2):uint()
            fci_tree:add(f_req_client_port, buffer(16, 2))

            local mcast_port = buffer(18, 2):uint()
            fci_tree:add(f_req_mcast_port, buffer(18, 2))

            local mcast_ip = buffer(20, 4):ipv4()
            fci_tree:add(f_req_mcast_ip, buffer(20, 4))

            -- STB ID (16 bytes)
            fci_tree:add(f_req_stb_id, buffer(24, 16))

            pinfo.cols.info:append(string.format(" (Client Port: %d, Mcast: %s:%d)",
                client_port, tostring(mcast_ip), mcast_port))
        end

    elseif fmt == 3 then
        -- Telecom Server Response (FMT 3)
        pinfo.cols.info = "FCC Server Response (Telecom)"

        -- Minimum FCC Server Response: 12-byte header + 36-byte FCI = 48 bytes
        if length >= 12 then
            -- Calculate FCI length (everything after the 12-byte RTCP header)
            local fci_length = length - 12
            local fci_tree = subtree:add(buffer(12, fci_length), string.format("FCI: Server Response (%d bytes)", fci_length))

            if fci_length >= 1 then
                local result_code = buffer(12, 1):uint()
                fci_tree:add(f_resp_result, buffer(12, 1))
            end

            if fci_length >= 2 then
                local action_code = buffer(13, 1):uint()
                fci_tree:add(f_resp_action, buffer(13, 1))
            end

            if fci_length >= 4 then
                local signal_port = buffer(14, 2):uint()
                fci_tree:add(f_resp_signal_port, buffer(14, 2))
            end

            if fci_length >= 6 then
                local media_port = buffer(16, 2):uint()
                fci_tree:add(f_resp_media_port, buffer(16, 2))
            end

            if fci_length >= 8 then
                fci_tree:add(f_resp_reserved, buffer(18, 2))
            end

            if fci_length >= 12 then
                local new_ip = buffer(20, 4):ipv4()
                fci_tree:add(f_resp_new_ip, buffer(20, 4))
            end

            if fci_length >= 16 then
                local valid_time = buffer(24, 4):uint()
                fci_tree:add(f_resp_valid_time, buffer(24, 4))
            end

            if fci_length >= 20 then
                local speed = buffer(28, 4):uint()
                local speed_item = fci_tree:add(f_resp_speed, buffer(28, 4))
                speed_item:append_text(string.format(" (%s)", format_bitrate(speed)))
            end

            if fci_length >= 24 then
                local speed_after_sync = buffer(32, 4):uint()
                local speed_after_sync_item = fci_tree:add(f_resp_speed_after_sync, buffer(32, 4))
                speed_after_sync_item:append_text(string.format(" (%s)", format_bitrate(speed_after_sync)))
            end

            -- Check if there are additional bytes beyond the basic 24-byte FCI
            if fci_length > 24 then
                local extra_bytes = fci_length - 24
                fci_tree:add(buffer(36, extra_bytes), string.format("Extended FCI Data (%d bytes)", extra_bytes))
            end

            -- Update info column if we have enough data
            if fci_length >= 2 then
                local result_code = buffer(12, 1):uint()
                local action_code = buffer(13, 1):uint()

                if result_code == 0 then
                    if action_code == 2 then
                        pinfo.cols.info:append(" (Success - Start Unicast)")
                    elseif action_code == 3 and fci_length >= 12 then
                        local new_ip = buffer(20, 4):ipv4()
                        local signal_port = buffer(14, 2):uint()
                        pinfo.cols.info:append(string.format(" (Redirect to %s:%d)",
                            tostring(new_ip), signal_port))
                    else
                        pinfo.cols.info:append(" (Success - Join Multicast)")
                    end
                else
                    pinfo.cols.info:append(" (Error)")
                end
            end
        end

    elseif fmt == 4 then
        -- Telecom Sync Notification (FMT 4)
        pinfo.cols.info = "FCC Sync Notification (Telecom)"
        subtree:add(buffer(12), "FCI: Sync Notification (Client can join multicast now)")

    elseif fmt == 5 then
        -- FMT 5 can be either:
        -- - Telecom Termination (16 bytes)
        -- - Huawei Client Request (32 bytes)
        -- Distinguish by packet length
        if length == 32 then
            -- Huawei Client Request (FMT 5)
            pinfo.cols.info = "FCC Client Request (Huawei RSR)"

            local fci_tree = subtree:add(buffer(12, 20), "FCI: Huawei Client Request")

            -- Reserved bytes (8 bytes)
            fci_tree:add(f_hw_req_reserved1, buffer(12, 8))

            -- Local IP address (4 bytes)
            fci_tree:add(f_hw_req_local_ip, buffer(20, 4))

            -- FCC client port (2 bytes)
            local client_port = buffer(24, 2):uint()
            fci_tree:add(f_hw_req_client_port, buffer(24, 2))

            -- Flag (2 bytes)
            fci_tree:add(f_hw_req_flag, buffer(26, 2))

            -- Redirect support flag (4 bytes)
            fci_tree:add(f_hw_req_redirect_flag, buffer(28, 4))

            local local_ip = buffer(20, 4):ipv4()
            pinfo.cols.info:append(string.format(" (Local: %s:%d)", tostring(local_ip), client_port))
        else
            -- Telecom Termination (FMT 5)
            pinfo.cols.info = "FCC Termination (Telecom)"

            if length >= 16 then
                local fci_tree = subtree:add(buffer(12, 4), "FCI: Termination")

                local stop_bit = buffer(12, 1):uint()
                fci_tree:add(f_term_stop_bit, buffer(12, 1))
                fci_tree:add(f_term_reserved, buffer(13, 1))

                local seqn = buffer(14, 2):uint()
                fci_tree:add(f_term_seqn, buffer(14, 2))

                if stop_bit == 0 then
                    pinfo.cols.info:append(string.format(" (Normal, SeqN: %d)", seqn))
                else
                    pinfo.cols.info:append(" (Force)")
                end
            end
        end

    elseif fmt == 6 then
        -- Huawei Server Response (FMT 6)
        pinfo.cols.info = "FCC Server Response (Huawei)"

        -- Minimum: 12-byte RTCP header + 4-byte FCI (result, reserved, type)
        if length >= 16 then
            local fci_length = length - 12
            local fci_tree = subtree:add(buffer(12, fci_length), string.format("FCI: Huawei Server Response (%d bytes)", fci_length))

            -- Result code (1 byte) - offset 12
            local result_code = buffer(12, 1):uint()
            fci_tree:add(f_hw_resp_result, buffer(12, 1))

            -- Reserved (1 byte) - offset 13
            if fci_length >= 2 then
                fci_tree:add(f_hw_resp_reserved1, buffer(13, 1))
            end

            -- Type (2 bytes) - offset 14-15
            local resp_type = 0
            if fci_length >= 4 then
                resp_type = buffer(14, 2):uint()
                fci_tree:add(f_hw_resp_type, buffer(14, 2))
            end

            -- Reserved (8 bytes) - offset 16-23
            if fci_length >= 12 then
                fci_tree:add(f_hw_resp_reserved2, buffer(16, 8))
            elseif fci_length > 4 then
                fci_tree:add(f_hw_resp_reserved2, buffer(16, fci_length - 4))
            end

            -- NAT flag (1 byte) - offset 24
            local nat_flag = 0
            if fci_length >= 13 then
                nat_flag = buffer(24, 1):uint()
                fci_tree:add(f_hw_resp_nat_flag, buffer(24, 1))
            end

            -- Reserved (1 byte) - offset 25
            if fci_length >= 14 then
                fci_tree:add(f_hw_resp_reserved3, buffer(25, 1))
            end

            -- Server port (2 bytes) - offset 26-27
            local server_port = 0
            if fci_length >= 16 then
                server_port = buffer(26, 2):uint()
                fci_tree:add(f_hw_resp_server_port, buffer(26, 2))
            end

            -- Session ID (4 bytes) - offset 28-31
            if fci_length >= 20 then
                local session_id = buffer(28, 4):uint()
                fci_tree:add(f_hw_resp_session_id, buffer(28, 4))
            end

            -- Server IP (4 bytes) - offset 32-35
            if fci_length >= 24 then
                fci_tree:add(f_hw_resp_server_ip, buffer(32, 4))
            end

            -- Additional extended data - offset 36+
            if fci_length > 24 then
                local extra_bytes = fci_length - 24
                fci_tree:add(buffer(36, extra_bytes), string.format("Extended Data (%d bytes)", extra_bytes))
            end

            -- Update info column
            -- result_code: 1 = success, others = error
            if result_code == 1 then
                if resp_type == 1 then
                    pinfo.cols.info:append(" (Success - No Unicast Needed)")
                elseif resp_type == 2 then
                    local need_nat = bit.band(bit.rshift(nat_flag, 5), 0x01)
                    if need_nat == 1 then
                        pinfo.cols.info:append(string.format(" (Success - Unicast, NAT Required, Port: %d)", server_port))
                    else
                        pinfo.cols.info:append(string.format(" (Success - Unicast, Port: %d)", server_port))
                    end
                elseif resp_type == 3 then
                    if fci_length >= 24 then
                        local server_ip = buffer(32, 4):ipv4()
                        pinfo.cols.info:append(string.format(" (Redirect to %s:%d)", tostring(server_ip), server_port))
                    else
                        pinfo.cols.info:append(string.format(" (Redirect to Port: %d)", server_port))
                    end
                else
                    pinfo.cols.info:append(string.format(" (Success - Unknown Type: %d)", resp_type))
                end
            else
                pinfo.cols.info:append(string.format(" (Error - Code: %d)", result_code))
            end
        end

    elseif fmt == 8 then
        -- Huawei Sync Notification (FMT 8)
        pinfo.cols.info = "FCC Sync Notification (Huawei)"
        if length > 12 then
            subtree:add(buffer(12, length - 12), "FCI: Huawei Sync Notification (Client can join multicast now)")
        else
            subtree:add(buffer(12), "FCI: Huawei Sync Notification")
        end

    elseif fmt == 9 then
        -- Huawei Termination (FMT 9)
        pinfo.cols.info = "FCC Termination (Huawei SCR)"

        if length >= 16 then
            local fci_tree = subtree:add(buffer(12, 4), "FCI: Huawei Termination")

            -- Status (1 byte)
            local status = buffer(12, 1):uint()
            fci_tree:add(f_hw_term_status, buffer(12, 1))

            -- Reserved (1 byte)
            fci_tree:add(f_hw_term_reserved, buffer(13, 1))

            -- First multicast sequence number (2 bytes)
            local seqn = buffer(14, 2):uint()
            fci_tree:add(f_hw_term_seqn, buffer(14, 2))

            if status == 1 then
                pinfo.cols.info:append(string.format(" (Joined Multicast, SeqN: %d)", seqn))
            elseif status == 2 then
                pinfo.cols.info:append(" (Error - Cannot Join Multicast)")
            else
                pinfo.cols.info:append(string.format(" (Status: %d, SeqN: %d)", status, seqn))
            end
        end

    else
        pinfo.cols.info = string.format("FCC Unknown FMT: %d", fmt)
    end
end

-- Register the dissector
-- FCC uses RTCP (PT 205) on custom ports, typically 8027 and 15970
local udp_port = DissectorTable.get("udp.port")
udp_port:add(8027, fcc_proto)   -- Default FCC client port
udp_port:add(15970, fcc_proto)  -- Default FCC server port

-- Also register as a heuristic dissector for RTCP
local function heuristic_checker(buffer, pinfo, tree)
    local length = buffer:len()
    if length < 8 then
        return false
    end

    -- Check for Huawei NAT traversal packet (8 bytes, magic 0x0003)
    if length == 8 then
        local magic = buffer(0, 2):uint()
        if magic == 0x0003 then
            fcc_proto.dissector(buffer, pinfo, tree)
            return true
        end
    end

    if length < 12 then
        return false
    end

    local first_byte = buffer(0, 1):uint()
    local version = bit.rshift(bit.band(first_byte, 0xC0), 6)
    local fmt = bit.band(first_byte, 0x1F)
    local pt = buffer(1, 1):uint()

    -- Check if this looks like an FCC packet
    -- Version should be 2, PT should be 205
    -- FMT values:
    -- Telecom: 2, 3, 4, 5
    -- Huawei: 5, 6, 8, 9
    if version == 2 and pt == 205 then
        if fmt == 2 or fmt == 3 or fmt == 4 or fmt == 5 or fmt == 6 or fmt == 8 or fmt == 9 then
            fcc_proto.dissector(buffer, pinfo, tree)
            return true
        end
    end

    return false
end

fcc_proto:register_heuristic("udp", heuristic_checker)
