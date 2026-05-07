package main

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"log"
	"math/big"
	"os"
	"time"
)

func main() {
	ca := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "Sentinel CA"},
		NotBefore:    time.Now(),
		NotAfter:     time.Now().AddDate(1, 0, 0),
		IsCA:                  true,
		BasicConstraintsValid: true,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth},
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
	}

	caPrivKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	caBytes, _ := x509.CreateCertificate(rand.Reader, ca, ca, &caPrivKey.PublicKey, caPrivKey)
	
	caPEM := new(bytes.Buffer)
	pem.Encode(caPEM, &pem.Block{Type: "CERTIFICATE", Bytes: caBytes})

	caPrivKeyPEM := new(bytes.Buffer)
	pem.Encode(caPrivKeyPEM, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(caPrivKey)})

	cert := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "sentinel-sidecar"},
		NotBefore:    time.Now(),
		NotAfter:     time.Now().AddDate(1, 0, 0),
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth},
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}

	certPrivKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	certBytes, _ := x509.CreateCertificate(rand.Reader, cert, ca, &certPrivKey.PublicKey, caPrivKey)

	certPEM := new(bytes.Buffer)
	pem.Encode(certPEM, &pem.Block{Type: "CERTIFICATE", Bytes: certBytes})

	certPrivKeyPEM := new(bytes.Buffer)
	pem.Encode(certPrivKeyPEM, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(certPrivKey)})

	yaml := fmt.Sprintf(`apiVersion: v1
kind: Secret
metadata:
  name: mtls-certs
  namespace: sentinel-crucible
type: Opaque
data:
  ca.crt: %s
  server.crt: %s
  server.key: %s
  client.crt: %s
  client.key: %s
`, 
		base64.StdEncoding.EncodeToString(caPEM.Bytes()),
		base64.StdEncoding.EncodeToString(certPEM.Bytes()),
		base64.StdEncoding.EncodeToString(certPrivKeyPEM.Bytes()),
		base64.StdEncoding.EncodeToString(certPEM.Bytes()), // reusing same cert for client for tests
		base64.StdEncoding.EncodeToString(certPrivKeyPEM.Bytes()),
	)

	os.WriteFile("00-certs.yaml", []byte(yaml), 0644)
	log.Println("Created 00-certs.yaml successfully")
}
