import { SetMetadata } from '@nestjs/common';

export const SKIP_RLS_TRANSACTION = 'SKIP_RLS_TRANSACTION';

export const SkipRlsTransaction = () => SetMetadata(SKIP_RLS_TRANSACTION, true);
