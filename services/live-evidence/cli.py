#!/usr/bin/env python3
"""BidForge service CLI; credentials remain in environment variables."""
import argparse
import json
import os
import sys
from pathlib import Path

import httpx


def main():
    parser=argparse.ArgumentParser()
    sub=parser.add_subparsers(dest='command',required=True)
    migrate=sub.add_parser('migrate')
    migrate.add_argument('--schema',default=str(Path(__file__).parent/'schema.sql'))
    for name,path in [('sync','/v1/ingestion/sync'),('adjudicate','/v1/adjudications')]:
        item=sub.add_parser(name);item.add_argument('--input',required=True);item.set_defaults(path=path)
    verify=sub.add_parser('verify');verify.add_argument('--certificate-id',required=True);verify.add_argument('--provider',required=True)
    args=parser.parse_args()
    if args.command=='migrate':
        from bidforge_live.repository import Repository
        dsn=os.environ.get('DATABASE_URL')
        if not dsn or not dsn.startswith(('postgresql://','postgres://')):
            parser.error('Set PostgreSQL DATABASE_URL')
        Repository(dsn).migrate(args.schema)
        print('PostgreSQL schema applied')
        return 0
    token=os.environ.get('BIDFORGE_CLIENT_TOKEN')
    base=os.environ.get('BIDFORGE_SERVICE_URL','http://127.0.0.1:8080')
    if not token:parser.error('Set BIDFORGE_CLIENT_TOKEN')
    if args.command=='verify':
        path='/v1/certificates/'+args.certificate_id+'/verify';payload={'provider':args.provider}
    else:
        path=args.path;payload=json.loads(Path(args.input).read_text())
    try:
        response=httpx.post(base.rstrip('/')+path,headers={'Authorization':'Bearer '+token},json=payload,timeout=120,follow_redirects=False)
        print(json.dumps(response.json(),indent=2))
        return 0 if response.is_success else 1
    except (httpx.HTTPError,ValueError):
        print('Service request failed; no credential-bearing request details are printed',file=sys.stderr)
        return 2

if __name__=='__main__':raise SystemExit(main())
