import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { assertIsolatedDatabase } from './helpers/isolated-database.ts';
const database = assertIsolatedDatabase();
assert.ok(process.env.GQXQ_TEST_DB_DATADIR, 'setup requires expected isolated MySQL datadir');
const connection = await mysql.createConnection({host:process.env.GQXQ_DB_HOST,port:Number(process.env.GQXQ_DB_PORT),user:process.env.GQXQ_DB_USER,password:process.env.GQXQ_DB_PASSWORD ?? '',multipleStatements:true});
try {
 const [rows]:any = await connection.query('select @@datadir as datadir');
 const normalize = (s:string) => s.replaceAll('\\','/').replace(/\/$/,'').toLowerCase();
 assert.equal(normalize(rows[0].datadir),normalize(process.env.GQXQ_TEST_DB_DATADIR!),'unexpected server datadir');
 // Refuse an existing schema: setup cannot overwrite a real or already-used database.
 await connection.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
 await connection.changeUser({database});
 await connection.query(readFileSync(new URL('./fixtures/sensitive-word-schema.sql', import.meta.url),'utf8'));
 console.log('Created synthetic sensitive-word fixture in '+database);
} finally { await connection.end(); }
