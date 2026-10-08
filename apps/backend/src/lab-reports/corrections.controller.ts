import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { type CorrectionCreate, correctionCreateSchema, type CorrectionDto, type IdParam, idParamSchema, type NoteDto } from '@telesphoros/shared-types';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CorrectionsService } from './corrections.service';
import { RequiresPipeline } from './pipeline-switch';

/** `POST /evaluations/:id/corrections`. Only a reviewer corrects; admin alone, clinician and reader cannot. */
@Controller('evaluations')
@RequiresPipeline()
export class EvaluationCorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Post(':id/corrections')
  @HttpCode(201)
  @Roles('reviewer')
  create(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(correctionCreateSchema)) body: CorrectionCreate,
  ): Promise<CorrectionDto> {
    return this.corrections.create(principal, id, body);
  }
}

/**
 * `GET /notes/:id`: the one way to read a note's text. Notes can contain identifiers typed by mistake, so this is limited to the roles that
 * already see report files (a reader does not), and the text is never logged.
 */
@Controller('notes')
@RequiresPipeline()
export class NotesController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Get(':id')
  @Roles('clinician', 'reviewer', 'admin')
  get(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam): Promise<NoteDto> {
    return this.corrections.note(principal, id);
  }
}
