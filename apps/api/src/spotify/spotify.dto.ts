import { IsIn } from 'class-validator';

export class TasteQueryDto {
  @IsIn(['short_term', 'medium_term', 'long_term'])
  timeRange: 'short_term' | 'medium_term' | 'long_term' =
    'medium_term';
}