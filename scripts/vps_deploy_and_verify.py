#!/usr/bin/env python3
"""Deploy fixed server.js to VPS (git pull), restart PM2, verify port 3000 + /health"""
import paramiko
import time

VPS_IP = "143.14.11.96"
VPS_USER = "root"
VPS_PASS = "Kitningfor2T!pKub!"

def exec_cmd(ssh, cmd, timeout=30):
    print(f"\n{'='*60}")
    print(f"CMD: {cmd}")
    print(f"{'='*60}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    if out.strip(): print(out)
    if err.strip(): print("STDERR:", err)
    return out, err

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(VPS_IP, username=VPS_USER, password=VPS_PASS, look_for_keys=False, allow_agent=False)

# 1. Git pull latest code
print("### STEP 1: Git pull latest on VPS ###")
exec_cmd(ssh, "su - tipkub -c 'cd /home/tipkub/app && git pull origin main 2>&1'")

# 2. Restart PM2
print("\n### STEP 2: Restart PM2 ###")
exec_cmd(ssh, "su - tipkub -c 'export NVM_DIR=$HOME/.nvm && [ -s $NVM_DIR/nvm.sh ] && . $NVM_DIR/nvm.sh && cd /home/tipkub/app && pm2 restart tipkub --update-env && pm2 save'")

# 3. Wait for startup
time.sleep(5)

# 4. Check PM2 status
print("\n### STEP 3: PM2 Status ###")
exec_cmd(ssh, "su - tipkub -c 'export NVM_DIR=$HOME/.nvm && [ -s $NVM_DIR/nvm.sh ] && . $NVM_DIR/nvm.sh && pm2 status'")

# 5. Check port 3000
print("\n### STEP 4: Check port 3000 ###")
out, err = exec_cmd(ssh, "ss -tlnp | grep 3000 || netstat -tlnp 2>/dev/null | grep 3000")
if not out.strip():
    print("❌ Port 3000 NOT LISTENING!")
else:
    print("✅ Port 3000 is listening!")

# 6. Test /health
print("\n### STEP 5: Test /health ###")
out, err = exec_cmd(ssh, "curl -s http://localhost:3000/health")
print(f"Health response: '{out.strip()}'")

# 7. Test homepage
print("\n### STEP 6: Test homepage ###")
out, err = exec_cmd(ssh, "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/")
print(f"Homepage HTTP status: {out.strip()}")

# 8. Check latest logs
print("\n### STEP 7: Latest logs ###")
exec_cmd(ssh, "cat /home/tipkub/logs/err.log 2>/dev/null | tail -5")
exec_cmd(ssh, "cat /home/tipkub/logs/out.log 2>/dev/null | tail -5")

ssh.close()
print("\n✅ Deployment complete!")