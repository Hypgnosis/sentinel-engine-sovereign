# **Guía de Despliegue: Sentinel Energy (CFE)**

Para activar la instancia de Energía, sigue estos pasos técnicos:

## **1\. Preparación de Datos (BigQuery)**

Ejecuta el esquema de base de datos en el nuevo dataset:

\-- Crear tablas en sentinel\_warehouse\_energy  
\-- (Usa el archivo schemas.sql original como base)

## **2\. Inyección de Variables de Entorno**

Al desplegar la Cloud Function, asegúrate de apuntar a la nueva instancia:

gcloud functions deploy sentinelInference \\  
  \--gen2 \\  
  \--set-env-vars="ACTIVE\_INSTANCE=energy-cfe,GCP\_PROJECT\_ID=ha-sentinel-core-v21,BQ\_DATASET=sentinel\_warehouse\_energy"

## **3\. Actualización del Frontend**

Asegúrate de que el componente Dashboard.jsx lea el accentColor desde el archivo JSON para cambiar los bordes y efectos de neón de **Azul Sentinel** a **Ámbar CFE (\#FFB300)**.
