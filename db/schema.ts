import {sqliteTable,text,integer,primaryKey} from 'drizzle-orm/sqlite-core';
export const boards=sqliteTable('qa_boards',{owner:text('owner').notNull(),id:text('id').notNull(),data:text('data').notNull(),version:integer('version').notNull().default(0)},table=>[primaryKey({columns:[table.owner,table.id]})]);
