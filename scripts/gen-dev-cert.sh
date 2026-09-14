#!/usr/bin/env bash
# 生成开发用自签证书，供真机 HTTPS 联调使用。
# 生产环境必须使用正规 CA 签发的证书，并在客户端做证书固定。
set -euo pipefail

OUT_DIR="${1:-.tmp/tls}"
mkdir -p "$OUT_DIR"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$OUT_DIR/key.pem" \
  -out "$OUT_DIR/cert.pem" \
  -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

echo "已生成自签证书：$OUT_DIR/cert.pem 与 $OUT_DIR/key.pem"
echo "启动服务端：TLS_CERT=$OUT_DIR/cert.pem TLS_KEY=$OUT_DIR/key.pem npm run server"
