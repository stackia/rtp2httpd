-- FCC (Fast Channel Change) Protocol Dissector for Wireshark
-- Based on RTCP Generic RTP Feedback format (RFC 4585)
--
-- Protocol Format:
-- FMT 2: Client Request
-- FMT 3: Server Response
-- FMT 4: Sync Notification
-- FMT 5: Termination Message

local fcc_proto = Proto("FCC", "Fast Channel Change Protocol")

-- Protocol fields
local f_version = ProtoField.uint8("fcc.version", "Version", base.DEC, nil, 0xC0)
local f_padding = ProtoField.uint8("fcc.padding", "Padding", base.DEC, nil, 0x20)
local f_fmt = ProtoField.uint8("fcc.fmt", "FMT (Feedback Message Type)", base.DEC, {
    [2] = "Client Request",
    [3] = "Server Response",
    [4] = "Sync Notification",
    [5] = "Termination"
}, 0x1F)
local f_payload_type = ProtoField.uint8("fcc.pt", "Payload Type", base.DEC)
local f_length = ProtoField.uint16("fcc.length", "Length", base.DEC)
local f_sender_ssrc = ProtoField.uint32("fcc.sender_ssrc", "Sender SSRC", base.HEX)
local f_media_ssrc = ProtoField.ipv4("fcc.media_ssrc", "Media Source SSRC (IP)")

-- FMT 2: Client Request fields
local f_req_version = ProtoField.uint32("fcc.req.version", "FCI Version", base.DEC, nil, 0xFF000000)
local f_req_reserved = ProtoField.uint32("fcc.req.reserved", "Reserved", base.HEX, nil, 0x00FFFFFF)
local f_req_client_port = ProtoField.uint16("fcc.req.client_port", "FCC Client Port", base.DEC)
local f_req_mcast_port = ProtoField.uint16("fcc.req.mcast_port", "Multicast Group Port", base.DEC)
local f_req_mcast_ip = ProtoField.ipv4("fcc.req.mcast_ip", "Multicast Group IP")
local f_req_stb_id = ProtoField.bytes("fcc.req.stb_id", "STB ID", base.SPACE)

-- FMT 3: Server Response fields
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

-- FMT 5: Termination fields
local f_term_stop_bit = ProtoField.uint8("fcc.term.stop_bit", "Stop Bit", base.DEC, {
    [0] = "Normal Termination",
    [1] = "Force Termination"
})
local f_term_reserved = ProtoField.uint8("fcc.term.reserved", "Reserved", base.HEX)
local f_term_seqn = ProtoField.uint16("fcc.term.seqn", "First Multicast Packet Sequence", base.DEC)

fcc_proto.fields = {
    f_version, f_padding, f_fmt, f_payload_type, f_length,
    f_sender_ssrc, f_media_ssrc,
    -- Client Request
    f_req_version, f_req_reserved, f_req_client_port, f_req_mcast_port, f_req_mcast_ip, f_req_stb_id,
    -- Server Response
    f_resp_result, f_resp_action, f_resp_signal_port, f_resp_media_port,
    f_resp_reserved, f_resp_new_ip, f_resp_valid_time, f_resp_speed, f_resp_speed_after_sync,
    -- Termination
    f_term_stop_bit, f_term_reserved, f_term_seqn
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

-- Dissector function
function fcc_proto.dissector(buffer, pinfo, tree)
    local length = buffer:len()
    if length == 0 then return end

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
        -- Client Request (FMT 2)
        pinfo.cols.info = "FCC Client Request"

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
        -- Server Response (FMT 3)
        pinfo.cols.info = "FCC Server Response"

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
        -- Sync Notification (FMT 4)
        pinfo.cols.info = "FCC Sync Notification"
        subtree:add(buffer(12), "FCI: Sync Notification (Client can join multicast now)")

    elseif fmt == 5 then
        -- Termination (FMT 5)
        pinfo.cols.info = "FCC Termination"

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
    if length < 12 then
        return false
    end

    local first_byte = buffer(0, 1):uint()
    local version = bit.rshift(bit.band(first_byte, 0xC0), 6)
    local fmt = bit.band(first_byte, 0x1F)
    local pt = buffer(1, 1):uint()

    -- Check if this looks like an FCC packet
    -- Version should be 2, PT should be 205, FMT should be 2, 3, 4, or 5
    if version == 2 and pt == 205 and (fmt == 2 or fmt == 3 or fmt == 4 or fmt == 5) then
        fcc_proto.dissector(buffer, pinfo, tree)
        return true
    end

    return false
end

fcc_proto:register_heuristic("udp", heuristic_checker)
