import React from 'react';
import logoIconImg from './assets/logo_icon.png';

interface LogoProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showText?: boolean;
}

export const OmniCrawlLogo: React.FC<LogoProps> = ({ 
  className = '', 
  size = 'md',
  showText = true 
}) => {
  // Sizing tuned so the artwork inside logo_2.png aligns vertically with text cap height
  const iconWrapperSizes = {
    sm: 'w-7 h-7',
    md: 'w-10 h-10',
    lg: 'w-16 h-16',
    xl: 'w-24 h-24'
  };

  const textSizes = {
    sm: 'text-lg',
    md: 'text-2xl',
    lg: 'text-4xl',
    xl: 'text-6xl'
  };

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      {/* Icon Container with 1.55x scale to trim white padding and align optically with text */}
      <div className={`relative ${iconWrapperSizes[size]} flex items-center justify-center shrink-0`}>
        <img 
          src={logoIconImg} 
          alt="OmniCrawl Icon" 
          className="w-full h-full object-contain scale-[1.55] mix-blend-multiply transform-gpu" 
        />
      </div>

      {showText && (
        <span className={`${textSizes[size]} font-black tracking-tight leading-none select-none flex items-center`}>
          <span className="text-[#6D28D9]">Omni</span>
          <span className="text-[#FF7A00]">Crawl</span>
        </span>
      )}
    </div>
  );
};

export default OmniCrawlLogo;
