export class SupabaseClientLite {
  private static url = process.env.WAHA_SUPABASE_URL;
  private static key = process.env.WAHA_SUPABASE_KEY;
  private static tableQR =
    process.env.WAHA_SUPABASE_TABLE_QR || 'waha_qr';
  private static tablePairing =
    process.env.WAHA_SUPABASE_TABLE_PAIRING || 'waha_pairing';

  static enabled(): boolean {
    return Boolean(this.url && this.key);
  }

  private static async insert(table: string, payload: unknown): Promise<void> {
    if (!this.enabled()) return;
    await fetch(`${this.url}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        apikey: this.key!,
        Authorization: `Bearer ${this.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(payload),
    });
  }

  static async saveQR(
    session: string,
    raw: string | undefined,
    pngBase64: string | undefined,
  ): Promise<void> {
    const payload = {
      session,
      qr_raw: raw || null,
      qr_png: pngBase64 || null,
      updated_at: new Date().toISOString(),
    };
    await this.insert(this.tableQR, payload);
  }

  static async savePairingCode(
    session: string,
    phoneNumber: string,
    code: string,
  ): Promise<void> {
    const payload = {
      session,
      phone_number: phoneNumber,
      code,
      created_at: new Date().toISOString(),
    };
    await this.insert(this.tablePairing, payload);
  }
}
