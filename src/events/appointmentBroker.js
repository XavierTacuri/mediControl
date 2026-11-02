'use strict';

/**
 * Broker de eventos de citas, EN MEMORIA, para las notificaciones SSE
 * (Fase 6). Administra suscriptores agrupados por clinic_id y reparte
 * (`publish`) los eventos solo entre los suscriptores de ese mismo
 * consultorio; el filtrado adicional por médico (un médico "puro" solo
 * recibe sus propias citas) lo aplica cada suscriptor en
 * `appointments.events.js`, no el broker.
 *
 * Limitaciones de escalabilidad (documentadas también en el README):
 *   - Solo funciona dentro de UN proceso de Node.js. Si la aplicación se
 *     ejecuta en varias instancias (p. ej. tras un balanceador de carga),
 *     cada instancia tiene su propio broker y sus propios suscriptores:
 *     un evento publicado en la instancia A nunca llega a un cliente
 *     conectado a la instancia B.
 *   - No persiste eventos: un suscriptor que se conecta después de que
 *     ocurrió un cambio simplemente no lo ve (no hay "replay"). No es una
 *     cola de mensajes ni garantiza entrega.
 *   - No es apropiado para escalado horizontal sin un mecanismo externo
 *     de distribución entre procesos (p. ej. Redis pub/sub, un bus de
 *     eventos); eso queda fuera de alcance de esta fase académica.
 *   - La interfaz (`subscribe`/`publish`/`closeAll`) se diseñó para poder
 *     sustituirse por una implementación respaldada por infraestructura
 *     compartida en una fase futura, sin cambiar a quienes la consumen
 *     (appointments.service.js / appointments.events.js).
 */
class AppointmentBroker {
  constructor({ maxConnectionsPerUser = 3 } = {}) {
    this.subscribersByClinic = new Map();
    this.maxConnectionsPerUser = maxConnectionsPerUser;
    this.connectionsByUser = new Map();
  }

  // Límite de conexiones SSE concurrentes por usuario (prototipo: evita que
  // una pestaña con fugas de conexiones agote los recursos del servidor).
  tryAcquireConnection(userKey) {
    const count = this.connectionsByUser.get(userKey) || 0;
    if (count >= this.maxConnectionsPerUser) {
      return false;
    }
    this.connectionsByUser.set(userKey, count + 1);
    return true;
  }

  releaseConnection(userKey) {
    const count = this.connectionsByUser.get(userKey) || 0;
    if (count <= 1) {
      this.connectionsByUser.delete(userKey);
    } else {
      this.connectionsByUser.set(userKey, count - 1);
    }
  }

  subscribe(clinicId, subscriber) {
    if (!this.subscribersByClinic.has(clinicId)) {
      this.subscribersByClinic.set(clinicId, new Set());
    }
    this.subscribersByClinic.get(clinicId).add(subscriber);

    return () => {
      const subscribers = this.subscribersByClinic.get(clinicId);
      if (!subscribers) return;
      subscribers.delete(subscriber);
      if (subscribers.size === 0) {
        this.subscribersByClinic.delete(clinicId);
      }
    };
  }

  publish(clinicId, event) {
    const subscribers = this.subscribersByClinic.get(clinicId);
    if (!subscribers) return;
    // Copia defensiva: deliver() puede desuscribirse a sí mismo (p. ej. si
    // la revalidación de sesión falla), lo que mutaría el Set mientras se
    // itera sobre él.
    for (const subscriber of Array.from(subscribers)) {
      subscriber.deliver(event);
    }
  }

  get subscriberCount() {
    let total = 0;
    for (const subscribers of this.subscribersByClinic.values()) {
      total += subscribers.size;
    }
    return total;
  }

  // Cierre ordenado (ver src/server.js): cierra todas las conexiones SSE
  // abiertas antes de que el proceso termine, en vez de dejarlas colgadas.
  closeAll() {
    for (const subscribers of this.subscribersByClinic.values()) {
      for (const subscriber of Array.from(subscribers)) {
        subscriber.close();
      }
    }
    this.subscribersByClinic.clear();
    this.connectionsByUser.clear();
  }
}

module.exports = { AppointmentBroker };
