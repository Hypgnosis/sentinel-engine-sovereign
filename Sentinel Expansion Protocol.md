# **Sentinel Engine: Multi-Industry Expansion Protocol**

**Version:** 1.1 (Arquitectura de Instancias Escalables) **Objective:** Clonar el Core de Sentinel para atacar mercados verticales (Energía, Fintech, MedTech, GovTech) manteniendo un solo código base para el motor.

## **🏗️ Estrategia de "Directorio de Configuración"**

En lugar de crear carpetas raíz separadas, utilizaremos un enfoque de **Instancias por Configuración**. El código del motor (Inference, RAG, Auth) vive en el core, y cada industria vive en una carpeta de instances.

### **Estructura de Carpetas Recomendada:**

/sentinel-engine  
  /core                 \<-- El "Cerebro" (No se toca por industria)  
    /functions          \<-- Cloud Functions genéricas  
    /shared             \<-- Lógica de BigQuery y JWT  
  /instances            \<-- Aquí "viven" las industrias  
    /logistics          \<-- Config actual  
    /energy-cfe         \<-- Nueva instancia para CFE  
    /fintech-global     \<-- Nueva instancia para Finanzas  
  /ui                   \<-- El Frontend (Lee de la instancia activa)

## **🚀 Pasos para Clonar a una Nueva Industria (Ejemplo: Energía)**

### **1\. Capa de Datos: Inyección de Contexto (BigQuery)**

No mezcles datos. Cada industria tiene su propio Dataset.

* **Acción:** Crear Dataset sentinel\_warehouse\_energy.  
* **SQL:** Ejecutar schemas.sql en el nuevo dataset para crear las tablas con la misma estructura (id, embedding, etc.).  
* **Refresco de Datos:** Ejecutar el script de UPDATE de timestamps para que los datos de energía se consideren "vivos" (dentro de las 24h).

### **2\. Capa Cognitiva: El archivo industry\_config.json**

Dentro de /instances/energy-cfe/, crear un archivo de configuración que el motor leerá al iniciar:

{  
  "industry": "Energy",  
  "accentColor": "\#FFB300",  
  "datasetId": "sentinel\_warehouse\_energy",  
  "systemPrompt": "Eres el Sentinel de Red Eléctrica. Tu especialidad es la resiliencia de carga y activos de alta tensión...",  
  "complexTriggers": \["caída de tensión", "falla de transformador", "anomalía térmica"\],  
  "heroScenarios": \[  
    { "label": "Riesgo de Apagón", "query": "Analiza la carga en la zona norte..." },  
    { "label": "Salud de Activos", "query": "Estado de transformadores en Topolobampo..." }  
  \]  
}

### **3\. Capa de UI: Refresco de Marca (Tailwind)**

El Frontend debe leer las variables de industry\_config.json.

* **Acción:** El archivo tailwind.config.js debe usar variables CSS (CSS Variables) que cambien según la instancia seleccionada.  
* **Resultado:** Cambias un string de "logistics" a "energy" y todo el dashboard cambia de Azul Sentinel a Ámbar CFE.

## **🚀 Flujo de Trabajo para el Ingeniero**

1. **Clonar la Configuración:** Copiar la carpeta /instances/template a /instances/energy-cfe.  
2. **Personalizar el JSON:** Editar prompts y triggers.  
3. **Desplegar con Variable de Entorno:**  
   \# Desplegar la instancia de energía  
   gcloud functions deploy sentinelInference \--set-env-vars="ACTIVE\_INSTANCE=energy-cfe"

## **🛡️ Reglas de Oro para la Expansión**

1. **Un solo Core:** Si el ingeniero necesita cambiar cómo funciona el RAG, lo hace en /core. El cambio se hereda automáticamente en Energía, Fintech y Logística.  
2. **Soberanía por Dataset:** Nunca uses el mismo Dataset de BigQuery para dos clientes diferentes.  
3. **Voz Consistente:** Usa el endpoint sentinelTTS compartido, pero el "narrative" que recibe vendrá del prompt de energía.

## **📈 Prioridad de Ataque al Mercado**

1. **Sentinel: Energy** (CFE México) \-\> Resiliencia de Red.  
2. **Sentinel: Fintech** \-\> Cumplimiento y Lavado de Dinero.  
3. **Sentinel: MedTech** \-\> Riesgos en Ensayos Clínicos.
