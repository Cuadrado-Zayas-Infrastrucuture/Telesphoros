/** @vitest-environment-options {"url":"http://127.0.0.1:4173"} */
import {render,screen,fireEvent} from '@testing-library/react';
import {vi,it,expect,beforeEach} from 'vitest';
import {MemoryRouter} from 'react-router-dom';
import LocalReviewPage from './LocalReviewPage';
const mocks=vi.hoisted(()=>({apiFetch:vi.fn(),roles:['reviewer'],pdfHash:'a'.repeat(64)}));
vi.mock('@/auth/AuthProvider',()=>({useAuth:()=>mocks}));
const id='11111111-1111-4111-8111-111111111111';
beforeEach(()=>{mocks.roles=['reviewer'];mocks.pdfHash='a'.repeat(64);mocks.apiFetch.mockReset();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('SYNTHETIC TEXT')));});
function setup(decision: 'accepted'|'rejected'|null=null, url='http://127.0.0.1:5555/file'){mocks.apiFetch.mockImplementation(async(path:string)=>new Response(JSON.stringify(path.endsWith('-url')?{url,expiresAt:'2026-10-09T00:00:00Z'}:{id,reportId:id,pdfSha256:mocks.pdfHash,textSha256:'b'.repeat(64),textScalars:14,popplerVersion:'26.03.0',runner:'fake',createdAt:'now',latestDecision:decision?{id,captureId:id,decision,textSha256:'b'.repeat(64),popplerVersion:'26.03.0',note:null,createdAt:'now'}:null})));render(<MemoryRouter><LocalReviewPage/></MemoryRouter>);fireEvent.change(screen.getByLabelText('Capture ID'),{target:{value:id}});fireEvent.click(screen.getByText('Open capture'));}
it('requires explicit comparison before reviewer decision and blocks pending evaluation',async()=>{setup();await screen.findByText('SYNTHETIC TEXT');expect(screen.getByText('Accept capture')).toBeDisabled();expect(screen.getByText('Run synthetic evaluation')).toBeDisabled();fireEvent.click(screen.getByLabelText('I compared the PDF and stored text, including field associations'));expect(screen.getByText('Accept capture')).toBeEnabled();});
it('clinician cannot decide even after comparison',async()=>{mocks.roles=['clinician'];setup();await screen.findByText('SYNTHETIC TEXT');fireEvent.click(screen.getByLabelText('I compared the PDF and stored text, including field associations'));expect(screen.getByText('Accept capture')).toBeDisabled();});
it('rejected capture cannot evaluate',async()=>{setup('rejected');await screen.findByText('SYNTHETIC TEXT');expect(screen.getByText('Run synthetic evaluation')).toBeDisabled();});
it('refuses an external file link before fetching text',async()=>{setup(null,'https://example.test/file');await screen.findByText('File destination is not the local emulator.');expect(fetch).not.toHaveBeenCalled();});

it('does not show a registered PDF preview for another hash',async()=>{setup();await screen.findByText('SYNTHETIC TEXT');expect(screen.queryByAltText('Rendered source PDF, D01 synthetic fixture')).not.toBeInTheDocument();});
it('shows the registered D01 preview for its exact PDF hash',async()=>{mocks.pdfHash='6b6d2a4578ac5ca2ac49db080d440320f3341b81ea0b81a7e29113a166c893f0';setup();await screen.findByText('SYNTHETIC TEXT');expect(screen.getByAltText('Rendered source PDF, D01 synthetic fixture')).toBeInTheDocument();});
