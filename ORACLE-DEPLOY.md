# aistock on Oracle Cloud Always Free

Zero-cost public deployment. Click-by-click — follow top-to-bottom, do not skip.

## 1. Sign up

1. https://signup.cloud.oracle.com — "Start for free".
2. Verify email, phone (SMS code), then **credit card** (KYC only, never charged for Always Free).
3. Pick a **Home Region** you can't change later. Pick one *close to you* that still has Ampere A1 capacity. Good bets: `Frankfurt`, `London`, `San Jose`, `Singapore`. Tokyo/Mumbai are usually full.
4. Wait for the "your tenancy is ready" email (5–30 min).

## 2. Make an SSH key (PowerShell on your Windows box)

```powershell
ssh-keygen -t ed25519 -f "$HOME\.ssh\oracle_aistock" -N """"
Get-Content "$HOME\.ssh\oracle_aistock.pub" | Set-Clipboard
```

The public key is now on your clipboard.

## 3. Create the VM

Console -> hamburger menu -> **Compute -> Instances -> Create instance**.

- Name: `aistock`
- Image: **Canonical Ubuntu 22.04** (minimal is fine).
- Shape: click **Change shape**.
  - **Preferred**: `Ampere -> VM.Standard.A1.Flex`, 4 OCPU, 24 GB RAM. Always Free includes 4 OCPU + 24 GB ARM total.
  - If you see **"Out of host capacity"** (common on A1): either click Create repeatedly over a few hours, switch Availability Domain (`AD-1/2/3` selector), or fall back to `Ampere` 1 OCPU/6 GB, or to `Specialty and previous generation -> VM.Standard.E2.1.Micro` (AMD x86, 1 OCPU/1 GB — always available, tight but works).
- Networking: leave the default VCN + public subnet, **Assign a public IPv4 address: yes**.
- SSH keys: **Paste public keys** -> paste the `oracle_aistock.pub` contents.
- **Create**. Wait ~1 min for the public IP to appear.

## 4. Open firewall (two layers — both required)

### a) VCN security list (Oracle's cloud firewall)

Console -> **Networking -> Virtual cloud networks** -> your VCN -> **Security Lists** -> Default Security List -> **Add Ingress Rules**. Add three rules, each: Source CIDR `0.0.0.0/0`, IP Protocol `TCP`, Destination Port Range `80`, `443`, `3000` (one rule per port).

### b) OS-level iptables (Oracle Ubuntu images block everything by default)

SSH in and run:

```bash
ssh -i $HOME\.ssh\oracle_aistock ubuntu@<public-ip>
```

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT
sudo netfilter-persistent save
```

## 5. Bootstrap

One command:

```bash
curl -fsSL https://raw.githubusercontent.com/yanapakapol/aistock/main/scripts/oracle-bootstrap.sh | bash
```

Takes ~5–10 min (most of it is the Docker build). On success it prints the URL.

## 6. First run

Open `http://<public-ip>:3000` -> `/register` -> create the admin account (first user becomes admin).

## 7. Updating later

```bash
bash /home/ubuntu/aistock/scripts/oracle-update.sh
```

## 8. (Optional) Free HTTPS + domain

1. Free subdomain at https://www.duckdns.org (sign in with GitHub, pick `aistock.duckdns.org`, point it at your public IP).
2. Add Caddy as a reverse proxy with auto-TLS:

```bash
sudo apt-get install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
aistock.duckdns.org {
  reverse_proxy 127.0.0.1:3000
}
EOF
sudo systemctl restart caddy
```

Caddy fetches a Let's Encrypt cert automatically. Visit `https://aistock.duckdns.org`. You can now close port 3000 in the VCN if you want.

## 9. Backups

Nightly `pg_dump` to `~/backups`, keep 14 days:

```bash
mkdir -p /home/ubuntu/backups
( crontab -l 2>/dev/null; cat <<'EOF'
0 3 * * * sudo docker exec aistock-db-1 pg_dump -U aistock -Fc aistock > /home/ubuntu/backups/aistock-$(date +\%F).dump && find /home/ubuntu/backups -name 'aistock-*.dump' -mtime +14 -delete
EOF
) | crontab -
```

**Also back up the master key off-box** — losing it makes every stored API key unrecoverable:

```bash
sudo cat /home/ubuntu/aistock/docker/secrets/master_key.txt
```

Copy that string into your password manager.

## Troubleshooting

- `curl http://<public-ip>:3000` from your laptop hangs -> step 4b iptables wasn't saved. Re-run.
- "Out of host capacity" on A1 -> try a different AD or fall back to `E2.1.Micro` in step 3.
- App container restart loop -> `sudo docker compose -f /home/ubuntu/aistock/docker/docker-compose.yml -f /home/ubuntu/aistock/docker/docker-compose.override.yml logs app`.
- Reboot test: `sudo reboot`; the `aistock.service` systemd unit brings the stack back up.
