import { useState } from 'react';
import type { GenomicProfileDto } from '@telesphoros/shared-types';
import { GenomicCheckRow } from '@/components/patients/GenomicCheckRow';
import { GenomicDrugCheck } from '@/components/patients/GenomicDrugCheck';
import { GenomicGeneCards } from '@/components/patients/GenomicGeneCards';
import { InfoButton } from '@/components/ui/InfoButton';
import { drugName, isCombination } from '@/lib/genomicProfileDrugs';
import { awaitingLine, coverageLine, NOTICE_WORDS, PROFILE_WORDS, summaryLine, untestedGenes } from '@/lib/genomicProfileWords';

/**
 * The loaded profile, in the order of decision B-D1. Under the medications heading, one line always says what the medication check covers,
 * or that it is not running yet (spec 045 N3-D2), so a row with no notice never reads as "no interaction"; the ⓘ gives the full text.
 */
export function GenomicProfileBody({ profile, patientId }: { profile: GenomicProfileDto; patientId: string }) {
  const awaiting = awaitingLine(profile.awaitingLinkReview.length);
  const [about, setAbout] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <p className="rounded-lg bg-muted px-3 py-2 font-medium">{summaryLine(profile)}</p>
      {awaiting && (
        <p role="status" className="rounded-lg bg-warning-surface px-3 py-2 text-sm">
          {awaiting}
        </p>
      )}
      {profile.capped && <p className="text-sm font-medium text-warning">{PROFILE_WORDS.capped}</p>}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <h3 id="genomic-medications-heading" className="font-semibold">
              {PROFILE_WORDS.medicationsHeading}
            </h3>
            <InfoButton label={NOTICE_WORDS.aboutLabel} open={about} controls="genomic-medications-about" onToggle={() => setAbout((value) => !value)} />
          </div>
          <p className="text-sm text-muted-foreground">{coverageLine(profile)}</p>
          {about && (
            <p id="genomic-medications-about" className="text-sm text-muted-foreground">
              {NOTICE_WORDS.about}
            </p>
          )}
        </div>
        {profile.medications.length === 0 ? (
          <p className="text-sm">{PROFILE_WORDS.noMedications}</p>
        ) : (
          profile.medications.map((check, index) => (
            <GenomicCheckRow
              key={`${check.rxcui}-${index}`}
              check={check}
              name={check.name ?? drugName(check.rxcui) ?? check.rxcui}
              genes={profile.genes}
              combination={isCombination(check.rxcui)}
            />
          ))
        )}
      </div>
      <GenomicDrugCheck patientId={patientId} />
      <GenomicGeneCards genes={profile.genes} untested={untestedGenes(profile)} />
    </div>
  );
}
