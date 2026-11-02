# MediControl V1.0 — Backend (API REST)

Entrega académica — **Universidad Politécnica Salesiana**, Aplicaciones
Web, Unidad 2 (Programación del lado del servidor).

> ⚠️ **Alcance académico.** Este backend utiliza exclusivamente datos
> ficticios y **no está autorizado para almacenar ni procesar datos
> médicos reales**. No implementa historias clínicas, recetas, signos
> vitales ni facturación.

## 1. Objetivo

MediControl es un sistema de gestión de consultorios médicos. Este
repositorio contiene **únicamente el backend**: una API REST en
Node.js/Express que administra pacientes y citas médicas, con
autenticación por sesión y permisos por rol. Existe también una interfaz
de prueba en React, pero **no forma parte de esta entrega** — este
repositorio es exclusivamente la API y puede probarse de forma completa
mediante la documentación interactiva incluida (Scalar) o con `curl`.

## 2. Alcance de la Unidad 2

Los dos módulos funcionales de esta entrega son:

1. **Registro y gestión de pacientes.**
2. **Agendamiento y gestión de citas médicas.**

Como soporte de esos dos módulos: autenticación por sesión, permisos
RBAC por consultorio, protección CSRF y notificaciones de citas en tiempo
real (SSE). **No implementa:** historias clínicas, diagnósticos, recetas,
signos vitales, facturación, cobros, inventario ni integraciones
externas.

## 3. Arquitectura (Node.js + Express)

- **Node.js 24** + **Express 5**, en CommonJS.
- Capas separadas por módulo de negocio (`routes` → `controller` →
  `service` → `repository`, más `schema` para validación): ver
  `src/modules/{auth,patients,appointments}/`.
- Middlewares transversales en `src/middlewares/`: autenticación
  (`requireAuth.js`), resolución de consultorio desde la sesión
  (`clinicContext.js`), permisos RBAC (`requirePermission.js`), CSRF
  (`csrf.js`), almacén de sesiones (`sqliteSessionStore.js`), manejo
  centralizado de errores (`errorHandler.js`) y un contexto DEMO
  (`demoContext.js`) **solo para pruebas automatizadas**, nunca
  alcanzable desde una petición HTTP real.
- `src/events/appointmentBroker.js`: broker de notificaciones en memoria
  para el canal SSE.
- `src/docs/`: generación de la especificación OpenAPI y la interfaz
  Scalar (ver sección 10).
- `src/app.js` ensambla la aplicación Express (inyectando la conexión
  SQLite, el reloj y el broker, lo que permite pruebas deterministas y
  aisladas); `src/server.js` la arranca, maneja `SIGINT`/`SIGTERM` y
  cierra la base de datos y las conexiones SSE abiertas de forma
  ordenada.

## 4. Persistencia (SQLite)

- `better-sqlite3`, con `PRAGMA foreign_keys = ON`, `journal_mode = WAL`
  y `busy_timeout` configurado (`src/db/database.js`).
- Esquema (`src/db/schema.js`): `clinics`, `users`, `clinic_memberships`
  (rol por usuario y consultorio), `patients`, `appointments`, `sessions`
  (almacén de sesiones HTTP). Claves foráneas, restricciones `CHECK` y
  disparadores (`TRIGGER`) que garantizan que un paciente y el médico de
  una cita pertenezcan al mismo consultorio y que el médico tenga
  realmente el rol `doctor` ahí.
- La ruta del archivo SQLite es configurable (`DATABASE_PATH`); se crea
  automáticamente si no existe. No se incluye ninguna base de datos en
  este repositorio.

## 5. CRUD de pacientes

`POST /api/patients`, `GET /api/patients` (búsqueda y paginación),
`GET /api/patients/:id`, `PATCH /api/patients/:id`,
`DELETE /api/patients/:id`. Siempre aislado por `clinic_id` resuelto en
el servidor; `DELETE` se rechaza (`409`) si el paciente tiene citas
registradas (sin borrado en cascada). Detalle completo de campos,
validaciones y respuestas en la documentación Scalar (sección 10) y en
`src/modules/patients/`.

## 6. CRUD de citas

`POST /api/appointments`, `GET /api/appointments` (filtros por médico,
paciente, estado y rango de fechas, con paginación),
`GET /api/appointments/:id`, `PATCH /api/appointments/:id`
(reprogramar o cambiar de estado), `DELETE /api/appointments/:id`
(cancelación lógica, nunca borra la fila), y
`GET /api/appointments/doctors` (médicos autorizados del consultorio,
para construir un selector). Incluye:

- **Prevención de solapamientos**: un médico no puede tener dos citas
  activas (`scheduled`/`confirmed`) que se superpongan; se valida de
  forma transaccional (`BEGIN IMMEDIATE`) para evitar condiciones de
  carrera.
- **Máquina de estados**: `scheduled → confirmed/cancelled`,
  `confirmed → completed/cancelled`; `completed`/`cancelled` son
  terminales.
- Un médico sin rol `secretary` solo puede gestionar **sus propias**
  citas, nunca las de otro médico del mismo consultorio.

Detalle completo en `src/modules/appointments/` y en Scalar.

## 7. Autenticación y sesiones

- `POST /api/auth/login` (bcrypt, mensaje de error genérico e idéntico
  para usuario inexistente/contraseña incorrecta/cuenta inactiva,
  regeneración del id de sesión, límite de intentos fallidos),
  `POST /api/auth/logout`, `GET /api/auth/me`,
  `POST /api/auth/clinic` (selección de consultorio cuando el usuario
  pertenece a varios).
- Sesión HTTP (`express-session`) con cookie `HttpOnly`, `SameSite=lax`,
  `Secure` en producción, respaldada por un almacén propio sobre SQLite
  (`src/middlewares/sqliteSessionStore.js`) — no el `MemoryStore` por
  defecto, que no sobrevive un reinicio.
- **Protección CSRF**: toda escritura (`POST`/`PATCH`/`DELETE`) exige la
  cabecera `X-CSRF-Token` con el valor recibido al iniciar sesión.
- El `clinic_id` de cada operación se resuelve **siempre en el
  servidor**, a partir de la sesión; nunca se acepta de un header o
  parámetro del cliente.

## 8. Roles: médico, secretaria y enfermera

Matriz de permisos centralizada (`src/middlewares/requirePermission.js`),
por consultorio (`clinic_memberships`, un usuario puede tener varios
roles y en varios consultorios):

| Rol | Permisos |
|---|---|
| `doctor` | Pacientes: crear/leer/actualizar. Citas: crear/leer/actualizar/cancelar — **solo las propias**, salvo que también tenga `secretary`. |
| `secretary` | Igual que `doctor` + eliminar pacientes, y gestiona la agenda de **todo** el consultorio (cualquier médico). |
| `nurse` | Sin permisos sobre pacientes/citas en esta fase (sin un modelo de asignación verificable todavía; se deniega en vez de inventar un acceso). |
| `admin` | Solo `users:manage`/`clinic:configure` (sin endpoints en esta fase); **no otorga acceso clínico por sí solo**. |

Un "médico independiente" (un único usuario con `admin`+`doctor`+
`secretary` en su propio consultorio) obtiene acceso clínico completo
porque tiene el rol `secretary`, no por tener `admin`.

## 9. Notificaciones en tiempo real (SSE)

`GET /api/appointments/events` abre un canal **Server-Sent Events**
persistente (no una respuesta única): emite
`appointment.created`/`updated`/`cancelled`/`completed` justo después de
que cada cambio se confirma en SQLite, nunca en operaciones fallidas ni
duplicadas. El payload es mínimo (ids y estado, nunca nombres de
pacientes ni datos clínicos). Respeta el mismo aislamiento por
consultorio y por médico que el resto de la API, y revalida la sesión de
forma periódica mientras la conexión sigue abierta (detecta logout,
expiración o cambio de consultorio sin esperar a la próxima petición).

```bash
curl -N -b cookies.txt http://localhost:3000/api/appointments/events
```

## 10. Documentación interactiva (Scalar / OpenAPI)

```
GET /api/docs           # interfaz Scalar
GET /api/openapi.json   # documento OpenAPI 3.0.3
```

Generado desde anotaciones reales (`src/docs/openapi/*.js`) con
`swagger-jsdoc`; ningún endpoint documentado es inventado. Disponible
**solo fuera de producción** (`NODE_ENV=production` lo apaga sin
excepción, incluso ante un error de configuración). Permite "Try it"
contra el backend real: inicia sesión desde la propia interfaz y copia
el `csrfToken` al candado de autenticación antes de probar una
escritura.

## 11. Instalación

```bash
npm ci
```

(`npm ci` en vez de `npm install`: instala exactamente las versiones de
`package-lock.json`, reproducible para la corrección académica.)

## 12. Configuración (`.env`)

```bash
cp .env.example .env
```

Variables:

| Variable | Descripción |
|---|---|
| `PORT` | Puerto del servidor (por defecto 3000). |
| `NODE_ENV` | `development` para uso local; `production` apaga el modo DEMO y la documentación Scalar. |
| `DATABASE_PATH` | Ruta del archivo SQLite (se crea si no existe). |
| `DEMO_MODE` | Atajo de contexto para pruebas/demo local, **nunca disponible en producción**. |
| `SESSION_SECRET` | Firma las cookies de sesión. **Obligatoria en producción** (el arranque falla si falta). Genera una propia: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `SESSION_TTL_MS` | Duración de la sesión en milisegundos. |
| `DEMO_USERS_PASSWORD` | Contraseña para los usuarios ficticios de `npm run seed:demo` (ver sección 13). Defínela solo en tu `.env` local; nunca la commitees. |

`.env.example` no contiene ningún secreto real — solo placeholders.

## 13. Usuarios ficticios de demostración

```bash
# en tu .env local:
DEMO_USERS_PASSWORD=una-contraseña-solo-para-tu-máquina

npm run seed:demo
```

Crea (de forma idempotente) cinco perfiles con contraseñas con hash
bcrypt y correos `@example.test`:

| Email | Rol(es) |
|---|---|
| `medico.independiente@example.test` | `admin` + `doctor` + `secretary` (consultorio propio) |
| `doctora.demo@example.test` | `doctor` |
| `secretaria.demo@example.test` | `secretary` |
| `enfermera.demo@example.test` | `nurse` |
| `admin.demo@example.test` | `admin` |

El script se niega a correr con `NODE_ENV=production` y nunca escribe la
contraseña en el código fuente.

## 14. Ejecución

```bash
npm start   # producción: node src/server.js
npm run dev # desarrollo: node --watch src/server.js (recarga automática)
```

El servidor escucha en `http://localhost:3000` (o el `PORT` configurado).

## 15. Pruebas

```bash
npm test
```

Ejecuta `node --test` sobre `tests/*.test.js`: esquema SQLite e
integridad, CRUD de pacientes, CRUD de citas (solapamientos,
transiciones, cancelación lógica), autenticación/sesiones/CSRF/RBAC,
aislamiento entre consultorios, notificaciones SSE, y la especificación
OpenAPI/Scalar. Cada prueba usa una base de datos SQLite aislada
(`:memory:` o un archivo temporal); ninguna toca datos reales.

## 16. Ejemplo de solicitud y respuesta

```bash
curl -i -c cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"medico.independiente@example.test","password":"<DEMO_USERS_PASSWORD>"}'
```

```json
{
  "user": { "id": 1, "name": "Médico de Prueba", "email": "medico.independiente@example.test" },
  "clinics": [{ "clinic_id": 1, "clinic_name": "Consultorio Médico Demo", "roles": ["admin", "doctor", "secretary"] }],
  "activeClinicId": 1,
  "csrfToken": "..."
}
```

```bash
curl -b cookies.txt -X POST http://localhost:3000/api/patients \
  -H "Content-Type: application/json" -H "X-CSRF-Token: <csrfToken>" \
  -d '{"first_name":"Ana","last_name":"Ejemplo","phone":"0991234567","email":"ana@example.test"}'
```

```json
{ "id": 1, "first_name": "Ana", "last_name": "Ejemplo", "phone": "0991234567", "email": "ana@example.test", "created_at": "2026-11-01T20:45:20.890Z" }
```

Más ejemplos (pacientes, citas, errores 400/401/403/404/409/422/429) en
`GET /api/docs`.

## 17. Limitaciones académicas y de seguridad

- **Uso exclusivamente académico.** No está autorizado para datos
  médicos reales; no implementa historias clínicas, recetas, signos
  vitales, facturación ni cobros.
- El modo DEMO (`DEMO_MODE`) es un atajo de inyección de contexto para
  pruebas automatizadas y demostración local — nunca sustituye la
  autenticación real en producción (`NODE_ENV=production` lo apaga sin
  excepción).
- `nurse` no tiene permisos clínicos en esta fase por no existir todavía
  un modelo de asignación verificable (se deniega en vez de inventar un
  acceso).
- El limitador de intentos de login y el broker de eventos SSE son **en
  memoria y de un solo proceso**: no protegen entre réplicas de la
  aplicación ni sobreviven un reinicio; no aptos para un despliegue
  multi-instancia sin un almacén/broker compartido externo.
- No hay zona horaria por consultorio (las fechas de citas se normalizan
  a UTC) ni soporte multi-instancia para las sesiones más allá de
  SQLite.
- Este repositorio no incluye el frontend de prueba (React); la API
  puede probarse de forma completa con la documentación interactiva
  (Scalar) o con `curl`/un cliente HTTP equivalente.
