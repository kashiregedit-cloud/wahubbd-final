import type { Contact } from '@adiwajshing/baileys';
import { NowebContactSchema } from '@waha/core/engines/noweb/store/schemas';
import { KnexPaginator } from '@waha/utils/Paginator';

import { IContactRepository } from '../IContactRepository';
import { NOWEBSqlite3KVRepository } from './NOWEBSqlite3KVRepository';

class ContactPaginator extends KnexPaginator {
  indexes = ['id'];
}

export class Sqlite3ContactRepository
  extends NOWEBSqlite3KVRepository<Contact>
  implements IContactRepository
{
  protected Paginator = ContactPaginator;

  get schema() {
    return NowebContactSchema;
  }

  async findByLid(lid: string): Promise<Contact | null> {
    const table = this.table;
    // Fallback search for LID in data column
    const pattern = `%"lid":"${lid}"%`;
    const row = await this.knex(table).where('data', 'like', pattern).first();
    if (!row) {
      return null;
    }
    const contact = this.parse(row);
    if (contact.lid !== lid) {
      return null;
    }
    return contact;
  }
}
